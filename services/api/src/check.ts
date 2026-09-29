// `POST /v1/check` (Story 2.9; FR-1, FR-2, FR-3, AD-11, AD-17): validate, rate-limit, run the pipeline, answer
// a `CheckResponse`. Malformed input gets 400 `validation_failed` and a rate-limited Check 429 `rate_limited` (with
// `Retry-After`); neither writes anything nor consumes a nonce. A missing or invalid signature is not an error: the Check runs
// advisory-public. Logs never carry Declared Identity or signatures. The api never writes to the chain.
import {
  loadActiveListSnapshots,
  outboxExtraWrites,
  PostgresAccountStore,
  PostgresCheckInputs,
  PostgresIndexerStore,
  PostgresListStore,
  PostgresOutboxStore,
  PostgresPolicyVersionStore,
  PostgresRecordStore,
  recoverCheckSigner,
  uuidv7,
  type HorosDb,
  type HorosTx,
} from "@horos/adapters";
import type { ChainReader, ListSnapshot } from "@horos/core";
import { runCheck, type CheckDeps, type CheckPrincipal } from "@horos/pipeline";
import { CheckRequest } from "@horos/schema";
import type { Context, Hono } from "hono";
import { describeIssues, fail } from "./http.js";
import { FixedWindowLimiter } from "./rate-limit.js";

export const DEFAULT_CHECK_RATE_PER_MINUTE = 120;

export interface CheckRouteDeps {
  readonly check: CheckDeps<HorosTx>;
  /** Checks per minute per Customer (authenticated) or per client IP (advisory). Default 120. */
  readonly checkRatePerMinute?: number;
  readonly now: () => Date;
  /** The socket's remote address: the advisory rate-limit key unless trusted proxies say otherwise. */
  readonly remoteAddress?: (c: Context) => string | undefined;
  /** Reverse proxies in front of the api that append to `x-forwarded-for`. Default 0: the header is ignored. */
  readonly trustedProxyHops?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
}

/**
 * The client address for the advisory rate-limit key. With `trustedProxyHops` 0 the client-controlled
 * `x-forwarded-for` is ignored and the socket address is used. With n > 0 trusted proxies, each appended the address
 * it saw, so the entry n positions from the right is the one the outermost trusted proxy saw; when the header is
 * shorter than that, the socket address is used. `"unknown"` when nothing is known.
 */
export function clientIp(c: Context, trustedProxyHops = 0, remoteAddress?: (c: Context) => string | undefined): string {
  if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0) throw new RangeError("trustedProxyHops must be a non-negative integer");
  if (trustedProxyHops > 0) {
    const hops = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    const hop = hops[hops.length - trustedProxyHops];
    if (hop !== undefined) return hop;
  }
  return remoteAddress?.(c) ?? "unknown";
}

export function registerCheckRoute(app: Hono, deps: CheckRouteDeps): void {
  const limiter = new FixedWindowLimiter(deps.checkRatePerMinute ?? DEFAULT_CHECK_RATE_PER_MINUTE);
  const log = deps.log ?? (() => {});

  app.post("/v1/check", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, "validation_failed", "request body must be JSON");
    }
    const parsed = CheckRequest.safeParse(body);
    if (!parsed.success) return fail(c, "validation_failed", describeIssues(parsed.error));

    const ip = clientIp(c, deps.trustedProxyHops ?? 0, deps.remoteAddress);
    const admit = (p: CheckPrincipal): boolean =>
      limiter.take(p.kind === "customer" ? `customer:${p.customerId}` : `ip:${ip}`, deps.now().getTime());
    const outcome = await runCheck(parsed.data, deps.check, { admit });
    if (outcome.kind === "rate_limited") {
      log({ event: "check-rate-limited", principal: outcome.principal.kind });
      // Retry-After: whole seconds until the limiter window resets (at least 1).
      c.header("Retry-After", String(Math.max(1, Math.ceil(limiter.msUntilReset(deps.now().getTime()) / 1000))));
      return fail(c, "rate_limited", "too many Checks; retry after the current minute");
    }
    return c.json(outcome.response, 200);
  });
}

export interface PostgresCheckDepsOptions {
  readonly chainReader: ChainReader;
  readonly chainId: number;
  readonly now: () => Date;
  readonly newId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Default: the active snapshots from the list store. */
  readonly lists?: () => Promise<readonly ListSnapshot[]>;
  readonly limitWriteWaitMs?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
}

/** Wire the pipeline's Check ports to the Postgres and viem adapters. */
export function postgresCheckDeps(db: HorosDb, opts: PostgresCheckDepsOptions): CheckDeps<HorosTx> {
  const idAt = (nowMs: number) => (opts.newId === undefined ? uuidv7(nowMs) : opts.newId());
  const records = new PostgresRecordStore(db);
  const policies = new PostgresPolicyVersionStore(db);
  const accounts = new PostgresAccountStore(db);
  const outbox = new PostgresOutboxStore(db, idAt);
  const indexer = new PostgresIndexerStore(db);
  const inputs = new PostgresCheckInputs(db, idAt);
  const listStore = new PostgresListStore(db);
  let advisoryScopeReady = false;
  return {
    chainId: opts.chainId,
    chain: opts.chainReader,
    records,
    recoverCheckSigner,
    lists: opts.lists ?? (() => loadActiveListSnapshots(listStore)),
    activePolicy: (scope) => policies.active(scope),
    ensurePresetPolicy: (scope) => inputs.ensurePresetPolicy(scope, opts.now()),
    ensureAdvisoryScope: async () => {
      if (advisoryScopeReady) return;
      await records.ensureScope({ id: "advisory-public" });
      advisoryScopeReady = true;
    },
    mirror: (scope, a) => indexer.mirror(scope, a),
    pendingIntentTarget: (scope, a) => inputs.pendingIntentTarget(scope, a),
    hasHistory: (scope, a) => inputs.hasHistory(scope, a),
    identityBindings: (scope, keys) => inputs.identityBindings(scope, keys),
    nonceUsed: (scope, nonce) => inputs.nonceUsed(scope, nonce),
    bindingByWallet: (w) => accounts.bindingByWallet(w),
    outboxWrites: (evaluation, ctx) => outboxExtraWrites(evaluation, { ...ctx, newId: idAt }),
    intentState: (scope, a, recordId) => outbox.intentState(scope, a, recordId),
    intentTxHash: (scope, a, recordId) => inputs.intentTxHash(scope, a, recordId),
    now: opts.now,
    newId: () => idAt(opts.now().getTime()),
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    ...(opts.limitWriteWaitMs === undefined ? {} : { limitWriteWaitMs: opts.limitWriteWaitMs }),
    ...(opts.log === undefined ? {} : { log: opts.log }),
  };
}
