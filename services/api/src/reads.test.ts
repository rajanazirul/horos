import { PGlite } from "@electric-sql/pglite";
import {
  PostgresAccountStore,
  PostgresIndexerStore,
  PostgresOutboxStore,
  PostgresPolicyVersionStore,
  PostgresReadStore,
  PostgresRecordStore,
  runMigrations,
  upsertIntent,
  type HorosDb,
} from "@horos/adapters";
import { buildExternalRecord, type ChainReader, type ChainView, type ProvisionedKeys, type WalletRoles } from "@horos/core";
import {
  accountDomain,
  CounterpartyStatusPage,
  CounterpartyStatusView,
  DecisionRecord,
  ErrorEnvelope,
  READ_ACCESS_TYPES,
  RecordDetail,
  RecordPage,
  toWireTime,
  type Decision,
  type ExternalActor,
  type ExternalEvent,
  type Hex,
  type Scope,
} from "@horos/schema";
import { drizzle } from "drizzle-orm/pglite";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { uuidv7 } from "./index.js";

const TOKEN = "test-admin-token-not-a-secret";
const CHAIN_ID = 5042002;
// Well-known Foundry/Anvil dev keys. Test-only; never funded on any real network.
const payment = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const PAY = payment.address.toLowerCase() as Hex;
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const HUMAN: Hex = "0x3b60ebece31658efda2ad1cd28860cabbf2e4e85";
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-r", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-m", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-u", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};
const OTHER_ENFORCED: Scope = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f99";
const SHADOW_CUSTOMER = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e70";
const SHADOW: Scope = `shadow:${SHADOW_CUSTOMER}`;
const SHADOW_KEY = "hk_test_shadow_key_not_a_secret";
/** A misconfigured key the resolver maps to an enforced Scope (the shadow-only guard must refuse it). */
const ENFORCED_KEY = "hk_test_enforced_key_not_a_secret";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const EXPIRY = "2026-09-28T12:04:00.000Z";
const H = (c: string): Hex => `0x${c.repeat(64)}`;
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const domain = accountDomain(CHAIN_ID);

class FakeReader implements ChainReader {
  roleMap: WalletRoles = { payment: PAY, registrar: KEYS.registrar.address, model: KEYS.model.address, rules: KEYS.rules.address, human: HUMAN };
  rolesDown = false;
  chainDown = false;
  pinned = new Set<string>();
  remainingCalls = 0;
  async remaining(_w: Hex, cp: Hex): Promise<ChainView> {
    this.remainingCalls++;
    if (this.chainDown) throw new Error("rpc down");
    const pinned = this.pinned.has(cp);
    return { cpRemaining: 0n, walletRemaining: 0n, newPayeeRemaining: 0n, limit: pinned ? 0n : 7n, pinned, registered: true, humanSet: false, humanEpoch: 0n };
  }
  async roles() {
    if (this.rolesDown) throw new Error("rpc down");
    return this.roleMap;
  }
  async policy(): Promise<never> {
    throw new Error("unused");
  }
  async hasCode() {
    return true;
  }
  async simulate(): Promise<never> {
    throw new Error("unused");
  }
  async latestBlock(): Promise<never> {
    throw new Error("unused");
  }
  async logs(): Promise<never> {
    throw new Error("unused");
  }
  async blockTimestamp(): Promise<never> {
    throw new Error("unused");
  }
  async txFrom(): Promise<never> {
    throw new Error("unused");
  }
  async rolesAt(): Promise<never> {
    throw new Error("unused");
  }
  async hasCodeAt(): Promise<never> {
    throw new Error("unused");
  }
}

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

function decisionRecord(scope: Scope, customerId: string, counterparty: Hex, decision: Decision, advisory: boolean, seq: number, prevHash: Hex) {
  const enforced = scope.startsWith("enforced:");
  return DecisionRecord.parse({
    schemaVersion: 1,
    id: uuidv7(NOW.getTime()),
    scope,
    seq,
    prevHash,
    createdAt: toWireTime(NOW),
    trigger: "check",
    customerId,
    ...(enforced ? { policyWallet: WALLET } : {}),
    counterparty,
    amount: "1000000",
    declaredIdentity: { status: "unverified", value: { name: "Acme Data, Inc." } },
    hardRules: [],
    signals: [],
    skippedQuestions: [],
    riskTier: decision === "hold" ? "high" : decision === "block" ? "severe" : "low",
    confidence: "1.0000",
    questionSetVersion: "v1",
    policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
    presetVersion: "standard@1",
    decision,
    reason: `test ${decision}`,
    chainState: "live",
    simulated: false,
    advisory: advisory || !enforced,
  });
}

async function setup(opts: { publicDemo?: boolean; noResolver?: boolean } = {}) {
  const client = new PGlite();
  clients.push(client);
  const db = drizzle(client) as unknown as HorosDb;
  await runMigrations(db);
  const accounts = new PostgresAccountStore(db);
  const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: NOW });
  await accounts.setKeys(binding.customerId, KEYS, NOW);
  await accounts.bind(binding.customerId, WALLET, NOW);
  const scope = binding.scopeId as Scope;
  const customerId = binding.customerId;
  const records = new PostgresRecordStore(db);
  await records.ensureScope({ id: "advisory-public" });
  await records.ensureScope({ id: SHADOW, customerId: SHADOW_CUSTOMER });
  const reader = new FakeReader();
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    policyVersions: new PostgresPolicyVersionStore(db),
    adminToken: TOKEN,
    now: () => NOW,
    newId: () => uuidv7(),
    accounts,
    chainReader: reader,
    chainId: CHAIN_ID,
    reads: new PostgresReadStore(db),
    ...(opts.publicDemo === true ? { publicDemoScope: scope } : {}),
    ...(opts.noResolver === true ? {} : { resolveShadowKey: async (k: string) => (k === SHADOW_KEY ? SHADOW : k === ENFORCED_KEY ? scope : undefined) }),
    log: (e) => logs.push(e),
  });
  const decide = (cp: Hex, decision: Decision, o: { advisory?: boolean; scope?: Scope } = {}) => {
    const s = o.scope ?? scope;
    return records.append({ scope: s, build: (seq, prev) => decisionRecord(s, s === SHADOW ? SHADOW_CUSTOMER : customerId, cp, decision, o.advisory ?? false, seq, prev) });
  };
  let tx = 0;
  const external = (cp: Hex, actor: ExternalActor, event: ExternalEvent) =>
    records.append({
      scope,
      build: (seq, prev) =>
        buildExternalRecord(
          {
            id: uuidv7(NOW.getTime()),
            scope,
            createdAt: toWireTime(NOW),
            customerId,
            policyWallet: WALLET,
            actor,
            actorAddress: actor === "human" ? HUMAN : KEYS.registrar.address,
            txHash: `0x${(++tx).toString(16).padStart(64, "0")}`,
            blockNumber: 10n,
            blockTimestamp: toWireTime(NOW),
            carriedHash: H("0"),
            events: [{ ...event, args: { ...event.args, counterparty: cp } }],
          },
          seq,
          prev,
        ),
    });
  const outbox = new PostgresOutboxStore(db);
  const indexer = new PostgresIndexerStore(db);
  /** Queue an intent for `r` and claim it. */
  const claimIntent = async (cp: Hex, r: { record: { id: string }; recordHash: Hex }, pin: boolean) => {
    await upsertIntent(
      db,
      { scope, counterparty: cp, laneRole: pin ? "rules" : "registrar", target: pin ? 0n : 100n, pin, humanEpoch: 0n, recordId: r.record.id, recordHash: r.recordHash, now: NOW },
      uuidv7(NOW.getTime()),
    );
    const claimed = await outbox.claimNext(NOW);
    if (claimed === undefined) throw new Error("nothing claimed");
    return claimed.id;
  };
  const confirm = async (cp: Hex, r: { record: { id: string }; recordHash: Hex }, pin: boolean, txHash: Hex) => {
    const id = await claimIntent(cp, r, pin);
    await outbox.markSubmitted(id, "tx-1", NOW);
    await indexer.confirmIntent({ intentId: id, txHash, blockNumber: 50n, onchainLimitAfter: pin ? 0n : 100n, now: NOW });
  };
  const count = async () => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM decision_record`)).rows[0]?.n;
  return { app, db, client, scope, customerId, reader, logs, decide, external, outbox, indexer, claimIntent, confirm, count };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function readHeaders(signer = payment, wallet: Hex = WALLET, expiry = EXPIRY): Promise<Record<string, string>> {
  const signature = await signer.signTypedData({
    domain,
    types: READ_ACCESS_TYPES,
    primaryType: "ReadAccess",
    message: { policyWallet: wallet, expiry: BigInt(Date.parse(expiry) / 1000) },
  });
  return { "x-horos-wallet": wallet, "x-horos-expiry": expiry, "x-horos-signature": signature };
}

const path = (scope: string, rest: string) => `/v1/scopes/${encodeURIComponent(scope)}/${rest}`;
const get = async (ctx: Ctx, rest: string, headers?: Record<string, string>, scope: string = ctx.scope) =>
  ctx.app.request(path(scope, rest), { headers: headers ?? (await readHeaders()) });
const status = async (ctx: Ctx, cp: Hex) => {
  const res = await get(ctx, `counterparties/${cp}`);
  expect(res.status).toBe(200);
  return CounterpartyStatusView.parse(await res.json());
};

const limitSet = (newLimit: string): ExternalEvent => ({ logIndex: 0, name: "LimitSet", args: { oldLimit: "0", newLimit, humanEpoch: "1", recordHash: H("0") } });

describe("status over HTTP (the matrix)", () => {
  test("acceptance: an enforced hold stays held despite 50 advisory-public allow records for the same address", async () => {
    const ctx = await setup();
    const A = addr(0xa1);
    await ctx.decide(A, "hold");
    for (let i = 0; i < 50; i++) await ctx.decide(A, "allow", { scope: "advisory-public" });
    const s = await status(ctx, A);
    expect(s).toMatchObject({ counterparty: A, status: "held", lastSeq: 0, pinned: false, chainState: "live", limit: "7" });
  });

  test("hold sticky, block beats hold, advisory allow in enforced, human raise / set 0, unrecognised write", async () => {
    const ctx = await setup();
    const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map((n) => addr(0xb0 + n)) as [Hex, Hex, Hex, Hex, Hex, Hex];
    await ctx.decide(a, "hold");
    await ctx.decide(a, "allow");
    await ctx.decide(a, "allow");
    await ctx.decide(b, "hold");
    await ctx.decide(b, "block");
    await ctx.decide(b, "hold");
    const cHold = await ctx.decide(c, "hold");
    await ctx.decide(c, "allow", { advisory: true });
    await ctx.decide(d, "hold");
    await ctx.external(d, "human", limitSet("300000000"));
    await ctx.decide(e, "allow");
    await ctx.external(e, "human", limitSet("0"));
    await ctx.decide(f, "allow");
    await ctx.external(f, "registrar", { logIndex: 0, name: "CounterpartyRegistered", args: { limit: "500", recordHash: H("0") } });
    expect((await status(ctx, a)).status).toBe("held");
    expect((await status(ctx, b)).status).toBe("blocked");
    expect(await status(ctx, c)).toMatchObject({ status: "held", lastSeq: cHold.record.seq });
    expect((await status(ctx, d)).status).toBe("ok");
    expect((await status(ctx, e)).status).toBe("blocked");
    expect((await status(ctx, f)).status).toBe("held");
  });

  test("pin wins: chain pinned → pinned", async () => {
    const ctx = await setup();
    const A = addr(0xc1);
    await ctx.decide(A, "allow");
    ctx.reader.pinned.add(A);
    expect(await status(ctx, A)).toMatchObject({ status: "pinned", pinned: true, limit: "0", chainState: "live" });
  });

  test("pin receipt confirmed, RPC down, mirror not pinned → blocked, stale", async () => {
    const ctx = await setup();
    const A = addr(0xc2);
    const r = await ctx.decide(A, "block");
    await ctx.confirm(A, r, true, H("e"));
    await ctx.indexer.applyMirror(ctx.scope, A, { kind: "registered", limit: 0n }, { block: 1n, logIndex: 0 }, NOW);
    ctx.reader.chainDown = true;
    expect(await status(ctx, A)).toMatchObject({ status: "blocked", pinned: false, limit: "0", chainState: "stale" });
  });

  test("RPC down, mirror pinned → pinned, stale; the fallback is logged without identity", async () => {
    const ctx = await setup();
    const A = addr(0xc3);
    await ctx.decide(A, "block");
    await ctx.indexer.applyMirror(ctx.scope, A, { kind: "pinned" }, { block: 1n, logIndex: 0 }, NOW);
    ctx.reader.chainDown = true;
    expect(await status(ctx, A)).toMatchObject({ status: "pinned", pinned: true, limit: "0", chainState: "stale" });
    expect(ctx.logs).toContainEqual({ event: "status-chain-fallback", scope: ctx.scope, mirror: true });
  });

  test("an unseen address is ok with lastSeq null", async () => {
    const ctx = await setup();
    expect(await status(ctx, addr(0xff))).toMatchObject({ status: "ok", lastSeq: null });
  });

  test("the list uses the mirror (no RPC), is ordered by address and pages", async () => {
    const ctx = await setup();
    const [a, b, c] = [addr(1), addr(2), addr(3)];
    await ctx.decide(c, "hold");
    await ctx.decide(a, "allow");
    await ctx.indexer.applyMirror(ctx.scope, b, { kind: "pinned" }, { block: 1n, logIndex: 0 }, NOW);
    await ctx.decide(a, "allow", { scope: "advisory-public" });
    const res = await get(ctx, "counterparties?limit=2");
    expect(res.status).toBe(200);
    const p1 = CounterpartyStatusPage.parse(await res.json());
    expect(p1.counterparties.map((x) => [x.counterparty, x.status, x.chainState])).toEqual([
      [a, "ok", "stale"],
      [b, "pinned", "stale"],
    ]);
    expect(p1.nextCursor).toBe(b);
    const p2 = CounterpartyStatusPage.parse(await (await get(ctx, `counterparties?limit=2&after=${b}`)).json());
    expect(p2).toEqual({ counterparties: [{ counterparty: c, status: "held", lastSeq: 0, pinned: false, chainState: "stale" }], nextCursor: null });
    expect(ctx.reader.remainingCalls).toBe(0);
    expect((await get(ctx, "counterparties?limit=101")).status).toBe(400);
    expect((await get(ctx, "counterparties?after=nope")).status).toBe(400);
  });
});

describe("records over HTTP", () => {
  test("120 records → pages of 50 in seq order, nextCursor until the end", async () => {
    const ctx = await setup();
    for (let i = 0; i < 120; i++) await ctx.decide(addr(i + 1), "allow");
    const seqs: number[] = [];
    let after: number | null = null;
    let pages = 0;
    do {
      const res = await get(ctx, `records${after === null ? "" : `?after=${after}`}`);
      expect(res.status).toBe(200);
      const page = RecordPage.parse(await res.json());
      seqs.push(...page.records.map((r) => r.record.seq));
      after = page.nextCursor;
      pages++;
    } while (after !== null);
    expect(pages).toBe(3);
    expect(seqs).toEqual([...Array(120).keys()]);
    expect((await get(ctx, "records?limit=0")).status).toBe(400);
    expect((await get(ctx, "records?after=-1")).status).toBe(400);
    expect(RecordPage.parse(await (await get(ctx, "records?limit=100")).json()).records).toHaveLength(100);
  });

  test("detail: a record with 2 receipts; unknown id → 404", async () => {
    const ctx = await setup();
    const A = addr(0xd1);
    const r = await ctx.decide(A, "allow");
    const first = await ctx.claimIntent(A, r, false);
    await ctx.outbox.markNoop(first, NOW);
    await ctx.indexer.reconcileReceipts(NOW);
    await ctx.confirm(A, r, false, H("e"));
    const res = await get(ctx, `records/${r.record.id}`);
    expect(res.status).toBe(200);
    const d = RecordDetail.parse(await res.json());
    expect(d.recordHash).toBe(r.recordHash);
    expect(d.record).toEqual(r.record);
    expect(d.receipts.map((x) => x.status).sort()).toEqual(["confirmed", "noop"]);
    expect(d.receipts.find((x) => x.status === "confirmed")).toMatchObject({ txHash: H("e"), onchainLimitAfter: "100", blockNumber: "50", pin: false });
    const missing = await get(ctx, `records/${uuidv7(NOW.getTime())}`);
    expect(missing.status).toBe(404);
    expect(ErrorEnvelope.parse(await missing.json()).error.code).toBe("not_found");
    expect((await get(ctx, "records/not-a-uuid")).status).toBe(404);
  });
});

describe("access", () => {
  test("public demo Scope: no auth → 200; any other Scope without auth → 401", async () => {
    const ctx = await setup({ publicDemo: true });
    await ctx.decide(addr(1), "hold");
    const res = await get(ctx, "records", {});
    expect(res.status).toBe(200);
    expect(RecordPage.parse(await res.json()).records).toHaveLength(1);
    expect((await get(ctx, `counterparties/${addr(1)}`, {})).status).toBe(200);
    const other = await get(ctx, "records", {}, OTHER_ENFORCED);
    expect(other.status).toBe(401);
    expect(ErrorEnvelope.parse(await other.json()).error.code).toBe("unauthenticated");
  });

  test("signed read: live Payment key → 200; expired, too far, wrong signer, bad headers → 401; another Scope → 403", async () => {
    const ctx = await setup();
    expect((await get(ctx, "records")).status).toBe(200);
    expect((await get(ctx, "records", await readHeaders(payment, WALLET, "2026-09-28T11:59:59.000Z"))).status).toBe(401);
    expect((await get(ctx, "records", await readHeaders(payment, WALLET, "2026-09-28T12:06:00.000Z"))).status).toBe(401);
    expect((await get(ctx, "records", await readHeaders(stranger))).status).toBe(401);
    expect((await get(ctx, "records", { ...(await readHeaders()), "x-horos-signature": "0x12" })).status).toBe(401);
    // Not bound, wrong signer and a bad signature are indistinguishable (bound wallets are not revealed).
    const notBound = await get(ctx, "records", await readHeaders(payment, addr(0x77)));
    const wrongSigner = await get(ctx, "records", await readHeaders(stranger));
    expect(notBound.status).toBe(401);
    expect(ErrorEnvelope.parse(await notBound.json()).error.message).toBe(ErrorEnvelope.parse(await wrongSigner.json()).error.message);
    const forbidden = await get(ctx, "records", undefined, OTHER_ENFORCED);
    expect(forbidden.status).toBe(403);
    expect(ErrorEnvelope.parse(await forbidden.json()).error.code).toBe("forbidden");
    // Payment role rotated on-chain: the old key no longer reads.
    ctx.reader.roleMap = { ...ctx.reader.roleMap, payment: stranger.address.toLowerCase() as Hex };
    expect((await get(ctx, "records")).status).toBe(401);
    expect((await get(ctx, "records", await readHeaders(stranger))).status).toBe(200);
    ctx.reader.rolesDown = true;
    const down = await get(ctx, "records");
    expect(down.status).toBe(503);
    expect(ErrorEnvelope.parse(await down.json()).error).toMatchObject({ code: "unavailable", retryable: true });
  });

  test("shadow key: records 200, statuses empty, single status 404; unknown key → 401; other Scope → 403", async () => {
    const ctx = await setup();
    await ctx.decide(addr(1), "hold", { scope: SHADOW });
    const key = { "x-horos-api-key": SHADOW_KEY };
    const recs = await get(ctx, "records", key, SHADOW);
    expect(recs.status).toBe(200);
    expect(RecordPage.parse(await recs.json()).records).toHaveLength(1);
    const list = await get(ctx, "counterparties", key, SHADOW);
    expect(CounterpartyStatusPage.parse(await list.json())).toEqual({ counterparties: [], nextCursor: null });
    const single = await get(ctx, `counterparties/${addr(1)}`, key, SHADOW);
    expect(single.status).toBe(404);
    expect(ErrorEnvelope.parse(await single.json()).error.code).toBe("not_found");
    expect((await get(ctx, "records", { "x-horos-api-key": "nope" }, SHADOW)).status).toBe(401);
    const other = await get(ctx, "records", key, ctx.scope);
    expect(other.status).toBe(403);
    expect(ErrorEnvelope.parse(await other.json()).error.code).toBe("forbidden");
  });

  test("API key guards: a key resolving to an enforced Scope, an empty key, or no resolver → 401", async () => {
    const ctx = await setup();
    const enforcedKey = await get(ctx, "records", { "x-horos-api-key": ENFORCED_KEY }, ctx.scope);
    expect(enforcedKey.status).toBe(401);
    expect(ErrorEnvelope.parse(await enforcedKey.json()).error.code).toBe("unauthenticated");
    expect((await get(ctx, "records", { "x-horos-api-key": "" }, SHADOW)).status).toBe(401);
    const bare = await setup({ noResolver: true });
    expect((await get(bare, "records", { "x-horos-api-key": SHADOW_KEY }, SHADOW)).status).toBe(401);
  });

  test("Cache-Control: no-store on signed and API-key reads; the public demo may be cached", async () => {
    const ctx = await setup({ publicDemo: true });
    expect((await get(ctx, "records")).headers.get("cache-control")).toBeNull(); // public demo wins first
    const signed = await setup();
    expect((await get(signed, "records")).headers.get("cache-control")).toBe("no-store");
    expect((await get(signed, `counterparties/${addr(1)}`)).headers.get("cache-control")).toBe("no-store");
    expect((await get(signed, "records", { "x-horos-api-key": SHADOW_KEY }, SHADOW)).headers.get("cache-control")).toBe("no-store");
  });

  test("x-horos-signature values never reach the logs", async () => {
    const ctx = await setup();
    const headers = await readHeaders();
    await get(ctx, "records", headers);
    await get(ctx, `counterparties/${addr(1)}`, headers);
    await get(ctx, "records", await readHeaders(stranger));
    const logged = JSON.stringify(ctx.logs);
    expect(ctx.logs.length).toBeGreaterThan(0);
    expect(logged).not.toContain(headers["x-horos-signature"]?.slice(2, 40));
  });

  test("an invalid publicDemoScope fails createApp", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client) as unknown as HorosDb;
    expect(() =>
      createApp({ policyVersions: new PostgresPolicyVersionStore(db), adminToken: TOKEN, now: () => NOW, newId: () => uuidv7(), reads: new PostgresReadStore(db), publicDemoScope: "enforced:typo" }),
    ).toThrow(/publicDemoScope/);
  });

  test("a malformed scope → 404; a URL-encoded scope works", async () => {
    const ctx = await setup();
    const malformed = await get(ctx, "records", undefined, "enforced:nope");
    expect(malformed.status).toBe(404);
    expect(ErrorEnvelope.parse(await malformed.json()).error.code).toBe("not_found");
    const raw = await ctx.app.request(`/v1/scopes/${ctx.scope}/records`, { headers: await readHeaders() });
    expect(raw.status).toBe(200);
  });
});

describe("read-only", () => {
  test("POST/PUT/DELETE on read paths → 405 and nothing written; logs carry no identity", async () => {
    const ctx = await setup({ publicDemo: true });
    const r = await ctx.decide(addr(1), "hold");
    const before = await ctx.count();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const rest of ["records", `records/${r.record.id}`, "counterparties", `counterparties/${addr(1)}`]) {
        const res = await ctx.app.request(path(ctx.scope, rest), { method, headers: { "content-type": "application/json" }, body: "{}" });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
        expect(ErrorEnvelope.parse(await res.json()).error.code).toBe("validation_failed");
      }
    }
    // Only the four read paths are claimed; other paths under the prefix stay free for future routes.
    const unclaimed = await ctx.app.request(path(ctx.scope, "other"), { method: "POST" });
    expect(unclaimed.status).toBe(404);
    expect(ErrorEnvelope.parse(await unclaimed.json()).error.code).toBe("not_found");
    expect(await ctx.count()).toBe(before);
    await get(ctx, `records/${r.record.id}`, {});
    expect(ctx.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(ctx.logs)).not.toContain("Acme");
  });

  test("without `reads` the routes are not mounted", async () => {
    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client) as unknown as HorosDb;
    await runMigrations(db);
    const app = createApp({ policyVersions: new PostgresPolicyVersionStore(db), adminToken: TOKEN, now: () => NOW, newId: () => uuidv7() });
    expect((await app.request(path("advisory-public", "records"))).status).toBe(404);
  });
});
