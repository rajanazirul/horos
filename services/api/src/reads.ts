// Read-only Decision Record API and Counterparty status projection (Story 2.8; FR-27, FR-29, AD-19, AD-25):
//   GET /v1/scopes/:scope/records?after=&limit=
//   GET /v1/scopes/:scope/records/:id
//   GET /v1/scopes/:scope/counterparties?after=&limit=
//   GET /v1/scopes/:scope/counterparties/:address
// Access, first that applies: the configured public demo Scope (no auth); an `x-horos-api-key` resolved to a
// shadow Scope; a "Horos Account" ReadAccess signed by the wallet's live Payment key. No route here writes.
// Story 3.4: GET /v1/scopes/:scope/shadow-summary (same access) counts a shadow Scope's Decisions as "advisory" or
// "would-have-caught".
// Logs carry the scope and route only: never records, Declared Identity, keys or signatures.
import { recoverAccountSigner } from "@horos/adapters";
import { foldStatus, type AccountStore, type ChainReader, type ReadMirror, type ReadReceipt, type ReadStore, type StatusChain } from "@horos/core";
import {
  accountDomain,
  accountExpiryValid,
  Address,
  API_KEY_HEADER,
  HexSignature,
  READ_ACCESS_HEADERS,
  READ_PAGE_MAX,
  readAccessMessage,
  Scope,
  toBaseUnits,
  toWireTime,
  WireTime,
  type CounterpartyStatusPage,
  type CounterpartyStatusView,
  type Hex,
  type RecordDetail,
  type RecordPage,
  type ShadowSummary,
  type WriteReceiptView,
} from "@horos/schema";
import type { Context, Hono } from "hono";
import { fail } from "./http.js";

export { API_KEY_HEADER };

export interface ReadDeps {
  readonly reads: ReadStore;
  readonly now: () => Date;
  /** Needed for signed ReadAccess (and live single-status reads: `chainReader`). */
  readonly accounts?: AccountStore;
  readonly chainReader?: ChainReader;
  readonly chainId?: number;
  /** A Scope readable without auth (the Horos Demo wallet's Scope). */
  readonly publicDemoScope?: string;
  /** Maps a shadow API key to its shadow Scope, or undefined when unknown. Absent: API keys are refused. */
  readonly resolveShadowKey?: (key: string) => Promise<string | undefined>;
  /** A shadow Scope's outcome counts (Story 3.4). The summary route is mounted only when set. */
  readonly shadowSummary?: (scope: string) => Promise<ShadowSummary>;
  readonly log?: (entry: Record<string, unknown>) => void;
}

type Access = "public-demo" | "api-key" | "signed";
type Denied = { readonly code: "unauthenticated" | "forbidden" | "unavailable"; readonly message: string };

function receiptView(r: ReadReceipt): WriteReceiptView {
  return {
    id: r.id,
    recordId: r.recordId,
    outboxIntentId: r.outboxIntentId,
    status: r.status,
    pin: r.pin,
    txHash: r.txHash,
    onchainLimitAfter: r.onchainLimitAfter === null ? null : toBaseUnits(r.onchainLimitAfter),
    blockNumber: r.blockNumber === null ? null : r.blockNumber.toString(),
    createdAt: toWireTime(r.createdAt),
  };
}

function statusView(counterparty: Hex, entries: Parameters<typeof foldStatus>[0], chain: StatusChain): CounterpartyStatusView {
  const r = foldStatus(entries, chain);
  return {
    counterparty,
    status: r.status,
    lastSeq: r.lastSeq,
    pinned: r.pinned,
    ...(r.limit === undefined ? {} : { limit: toBaseUnits(r.limit) }),
    chainState: r.chainState,
  };
}

/** The mirror as a (stale) chain fact; no row → not pinned, Limit unknown. */
const mirrorChain = (m: ReadMirror | undefined): StatusChain =>
  m === undefined ? { pinned: false, chainState: "stale" } : { pinned: m.pinned, limit: m.limit, chainState: "stale" };

/** A non-negative integer query value, or undefined when absent; `null` when malformed. */
function intQuery(raw: string | undefined, min: number, max: number): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export function registerReadRoutes(app: Hono, deps: ReadDeps): void {
  const log = deps.log ?? (() => {});
  const domain = deps.chainId === undefined ? undefined : accountDomain(deps.chainId);

  async function signedAccess(c: Context, scope: string): Promise<Denied | undefined> {
    const walletRaw = c.req.header(READ_ACCESS_HEADERS.wallet);
    const expiryRaw = c.req.header(READ_ACCESS_HEADERS.expiry);
    const sigRaw = c.req.header(READ_ACCESS_HEADERS.signature);
    if (walletRaw === undefined || expiryRaw === undefined || sigRaw === undefined) {
      return { code: "unauthenticated", message: "an API key, a signed ReadAccess or the public demo Scope is required" };
    }
    if (deps.accounts === undefined || deps.chainReader === undefined || domain === undefined) {
      return { code: "unauthenticated", message: "signed read access is not available" };
    }
    const wallet = Address.safeParse(walletRaw);
    const expiry = WireTime.safeParse(expiryRaw);
    const sig = HexSignature.safeParse(sigRaw);
    if (!wallet.success || !expiry.success || !sig.success || Date.parse(expiry.data) % 1000 !== 0) {
      return { code: "unauthenticated", message: "malformed ReadAccess headers" };
    }
    if (!accountExpiryValid(expiry.data, deps.now())) {
      return { code: "unauthenticated", message: "ReadAccess expiry must be in the future and at most 300 seconds away" };
    }
    // Verify the signature against the live Payment key before looking up the binding, and answer "bad
    // signature", "wrong signer" and "not bound" alike, so the endpoint does not reveal which wallets are bound.
    const invalid: Denied = { code: "unauthenticated", message: "ReadAccess signature is not valid for this PolicyWallet" };
    const signer = await recoverAccountSigner(domain, { primaryType: "ReadAccess", message: readAccessMessage(wallet.data, expiry.data) }, sig.data);
    if (signer === undefined) return invalid;
    let payment: Hex;
    try {
      payment = (await deps.chainReader.roles(wallet.data)).payment;
    } catch {
      return { code: "unavailable", message: "could not read the PolicyWallet's live roles; retry shortly" };
    }
    if (signer !== payment) return invalid;
    const binding = await deps.accounts.bindingByWallet(wallet.data);
    if (binding?.status !== "bound") return invalid;
    if (binding.scopeId !== scope) return { code: "forbidden", message: "this PolicyWallet may not read that Scope" };
    return undefined;
  }

  /** Resolve access to `scope`: the first mechanism that applies decides. */
  async function access(c: Context, scope: string): Promise<{ ok: true; via: Access } | { ok: false; denied: Denied }> {
    if (deps.publicDemoScope !== undefined && scope === deps.publicDemoScope) return { ok: true, via: "public-demo" };
    const key = c.req.header(API_KEY_HEADER);
    if (key !== undefined) {
      const resolved = key.length === 0 || deps.resolveShadowKey === undefined ? undefined : await deps.resolveShadowKey(key);
      if (resolved === undefined || !resolved.startsWith("shadow:")) return { ok: false, denied: { code: "unauthenticated", message: "unknown API key" } };
      return resolved === scope ? { ok: true, via: "api-key" } : { ok: false, denied: { code: "forbidden", message: "this API key may not read that Scope" } };
    }
    const denied = await signedAccess(c, scope);
    return denied === undefined ? { ok: true, via: "signed" } : { ok: false, denied };
  }

  /** Parse `:scope` and authorise it; returns the Scope or an error response. */
  async function guard(c: Context, route: string): Promise<{ scope: Scope } | { res: Response }> {
    const parsed = Scope.safeParse(c.req.param("scope"));
    if (!parsed.success) return { res: fail(c, "not_found", "unknown scope") };
    const a = await access(c, parsed.data);
    if (!a.ok) return { res: fail(c, a.denied.code, a.denied.message) };
    log({ event: "read", route, scope: parsed.data, access: a.via });
    // Authenticated reads are private to their caller: never cache them. The public demo may be cached.
    if (a.via !== "public-demo") c.header("Cache-Control", "no-store");
    return { scope: parsed.data };
  }

  app.get("/v1/scopes/:scope/records", async (c) => {
    const g = await guard(c, "records");
    if ("res" in g) return g.res;
    const after = intQuery(c.req.query("after"), 0, Number.MAX_SAFE_INTEGER);
    const limit = intQuery(c.req.query("limit"), 1, READ_PAGE_MAX);
    if (after === null) return fail(c, "validation_failed", "after must be a non-negative integer seq");
    if (limit === null) return fail(c, "validation_failed", `limit must be an integer in 1..${READ_PAGE_MAX}`);
    const page = await deps.reads.listRecords(g.scope, {
      ...(after === undefined ? {} : { afterSeq: after }),
      ...(limit === undefined ? {} : { limit }),
    });
    const body: RecordPage = { records: page.items.map((r) => ({ recordHash: r.recordHash, record: r.record })), nextCursor: page.nextCursor };
    return c.json(body, 200);
  });

  app.get("/v1/scopes/:scope/records/:id", async (c) => {
    const g = await guard(c, "record");
    if ("res" in g) return g.res;
    const d = await deps.reads.recordDetail(g.scope, c.req.param("id"));
    if (d === undefined) return fail(c, "not_found", "no such record in this scope");
    const body: RecordDetail = { recordHash: d.record.recordHash, record: d.record.record, receipts: d.receipts.map(receiptView) };
    return c.json(body, 200);
  });

  app.get("/v1/scopes/:scope/counterparties", async (c) => {
    const g = await guard(c, "counterparties");
    if ("res" in g) return g.res;
    const afterRaw = c.req.query("after");
    const after = afterRaw === undefined ? undefined : Address.safeParse(afterRaw);
    const limit = intQuery(c.req.query("limit"), 1, READ_PAGE_MAX);
    if (after !== undefined && !after.success) return fail(c, "validation_failed", "after must be an address");
    if (limit === null) return fail(c, "validation_failed", `limit must be an integer in 1..${READ_PAGE_MAX}`);
    // The fold is enforced-only: shadow and advisory-public Scopes have no statuses.
    const info = await deps.reads.scopeInfo(g.scope);
    if (info?.kind !== "enforced") return c.json({ counterparties: [], nextCursor: null } satisfies CounterpartyStatusPage, 200);
    const page = await deps.reads.listCounterparties(g.scope, {
      ...(after === undefined ? {} : { after: after.data }),
      ...(limit === undefined ? {} : { limit }),
    });
    const body: CounterpartyStatusPage = {
      counterparties: page.items.map((i) => statusView(i.address, i.entries, mirrorChain(i.mirror))),
      nextCursor: page.nextCursor,
    };
    return c.json(body, 200);
  });

  app.get("/v1/scopes/:scope/counterparties/:address", async (c) => {
    const g = await guard(c, "counterparty");
    if ("res" in g) return g.res;
    const address = Address.safeParse(c.req.param("address"));
    if (!address.success) return fail(c, "validation_failed", "address must be a 0x address");
    const info = await deps.reads.scopeInfo(g.scope);
    if (info?.kind !== "enforced" || info.policyWallet === undefined) {
      return fail(c, "not_found", "statuses exist only in an enforced scope");
    }
    const inputs = await deps.reads.statusInputs(g.scope, address.data);
    // AD-3: the live `remaining(a)` is authoritative; on RPC failure fall back to the mirror, marked stale.
    let chain: StatusChain;
    try {
      if (deps.chainReader === undefined) throw new Error("no chain reader");
      const v = await deps.chainReader.remaining(info.policyWallet, address.data);
      chain = { pinned: v.pinned, limit: v.limit, chainState: "live" };
    } catch {
      chain = mirrorChain(inputs.mirror);
      log({ event: "status-chain-fallback", scope: g.scope, mirror: inputs.mirror !== undefined });
    }
    return c.json(statusView(address.data, inputs.entries, chain) satisfies CounterpartyStatusView, 200);
  });

  const shadowSummary = deps.shadowSummary;
  if (shadowSummary !== undefined) {
    app.get("/v1/scopes/:scope/shadow-summary", async (c) => {
      const g = await guard(c, "shadow-summary");
      if ("res" in g) return g.res;
      if (!g.scope.startsWith("shadow:")) return fail(c, "not_found", "a summary exists only for a shadow scope");
      return c.json((await shadowSummary(g.scope)) satisfies ShadowSummary, 200);
    });
  }

  // Read-only: any other method on these paths is refused and writes nothing.
  const readPaths = [
    "/v1/scopes/:scope/shadow-summary",
    "/v1/scopes/:scope/records",
    "/v1/scopes/:scope/records/:id",
    "/v1/scopes/:scope/counterparties",
    "/v1/scopes/:scope/counterparties/:address",
  ];
  app.on(["POST", "PUT", "PATCH", "DELETE"], readPaths, (c) => {
    c.header("Allow", "GET, HEAD");
    return fail(c, "validation_failed", "read-only endpoint", { status: 405 });
  });
}
