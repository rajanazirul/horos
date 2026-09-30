// Shadow Mode endpoints (Story 3.4; FR-28, AD-7, AD-11, AD-17, AD-25):
//   POST /v1/shadow        self-serve sign-up: a "Horos Account" ShadowSignup signed by the Payment key (or the admin
//                          bearer) finds or creates the Customer and its `shadow:<customerId>` Scope and returns a fresh
//                          API key once; the previous key is revoked
//   POST /v1/shadow/check  an `x-horos-api-key` Check: the same pipeline in the shadow Scope, advisory records, the
//                          Postgres virtual ledger, nothing queued for the chain
// Both answer 410 `shadow_closed` once the Customer's PolicyWallet is bound (nothing migrates). API keys, signatures and
// Declared Identity are never logged; the key reaches only the sign-up response body. Sign-up attempts and failed API
// keys are rate-limited per client IP (429), like advisory `/v1/check`; a Check with a valid key per Customer.
import { recoverAccountSigner, type HorosTx, type ShadowKeyOwner, type ShadowSignupResult } from "@horos/adapters";
import { shadowOutcome } from "@horos/core";
import { runShadowCheck, type CheckDeps, type CheckPrincipal } from "@horos/pipeline";
import {
  accountDomain,
  accountExpiryValid,
  API_KEY_HEADER,
  ShadowCheckRequest,
  shadowSignupMessageFromRequest,
  ShadowSignupRequest,
  type Hex,
  type ShadowCheckResponse,
  type ShadowSignupResponse,
  type ShadowSummary,
} from "@horos/schema";
import type { Context, Hono } from "hono";
import { clientIp, DEFAULT_CHECK_RATE_PER_MINUTE } from "./check.js";
import { describeIssues, fail } from "./http.js";
import { FixedWindowLimiter } from "./rate-limit.js";

/** The shadow store behind the routes (`PostgresShadowStore` in production). */
export interface ShadowAccounts {
  signup(paymentAddress: Hex, now: Date, nonce?: Hex): Promise<ShadowSignupResult>;
  resolveKey(key: string): Promise<ShadowKeyOwner | undefined>;
  summary(scope: string): Promise<ShadowSummary>;
}

export interface ShadowRouteDeps {
  readonly shadow: ShadowAccounts;
  /** The Check pipeline's ports; `ledger` must be set. */
  readonly check: CheckDeps<HorosTx>;
  readonly chainId: number;
  readonly now: () => Date;
  /** True when the request carries the valid admin bearer token. */
  readonly isAdmin: (c: Context) => boolean;
  /** Shadow Checks per minute per Customer. Default 120. */
  readonly checkRatePerMinute?: number;
  /** Sign-up attempts, and failed API keys, per minute per client IP. Default 20. */
  readonly shadowIpRatePerMinute?: number;
  /** The socket's remote address (the IP key unless trusted proxies say otherwise). */
  readonly remoteAddress?: (c: Context) => string | undefined;
  /** Reverse proxies appending to `x-forwarded-for`. Default 0: the header is ignored. */
  readonly trustedProxyHops?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
}

export const DEFAULT_SHADOW_IP_RATE_PER_MINUTE = 20;

async function jsonBody(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

const CLOSED = "this Customer's PolicyWallet is bound: Shadow Mode is closed; use signed Checks against the PolicyWallet";

export function registerShadowRoutes(app: Hono, deps: ShadowRouteDeps): void {
  if (deps.check.ledger === undefined) throw new Error("shadow routes need the virtual ledger (check.ledger)");
  const domain = accountDomain(deps.chainId);
  const limiter = new FixedWindowLimiter(deps.checkRatePerMinute ?? DEFAULT_CHECK_RATE_PER_MINUTE);
  const signupLimiter = new FixedWindowLimiter(deps.shadowIpRatePerMinute ?? DEFAULT_SHADOW_IP_RATE_PER_MINUTE);
  const badKeyLimiter = new FixedWindowLimiter(deps.shadowIpRatePerMinute ?? DEFAULT_SHADOW_IP_RATE_PER_MINUTE);
  const log = deps.log ?? (() => {});
  const ipOf = (c: Context) => `ip:${clientIp(c, deps.trustedProxyHops ?? 0, deps.remoteAddress)}`;
  const limited = (c: Context, l: FixedWindowLimiter, message: string): Response => {
    c.header("Retry-After", String(Math.max(1, Math.ceil(l.msUntilReset(deps.now().getTime()) / 1000))));
    return fail(c, "rate_limited", message);
  };

  app.post("/v1/shadow", async (c) => {
    if (!signupLimiter.take(ipOf(c), deps.now().getTime())) {
      log({ event: "shadow-signup-rate-limited" });
      return limited(c, signupLimiter, "too many sign-ups from this client; retry after the current minute");
    }
    const raw = await jsonBody(c);
    if (!raw.ok) return fail(c, "validation_failed", "request body must be JSON");
    const parsed = ShadowSignupRequest.safeParse(raw.body);
    if (!parsed.success) return fail(c, "validation_failed", describeIssues(parsed.error));
    const req = parsed.data;

    // Admin bearer, or a fresh ShadowSignup that recovers to the payment address. A present-but-wrong bearer fails.
    let nonce: Hex | undefined;
    if (c.req.header("authorization") !== undefined) {
      if (!deps.isAdmin(c)) return fail(c, "unauthenticated", "missing or invalid admin bearer token");
    } else {
      const auth = req.auth;
      if (auth === undefined) return fail(c, "unauthenticated", "a signed auth envelope or the admin bearer token is required");
      if (!accountExpiryValid(auth.expiry, deps.now())) return fail(c, "unauthenticated", "auth expiry must be in the future and at most 300 seconds away");
      const signer = await recoverAccountSigner(domain, { primaryType: "ShadowSignup", message: shadowSignupMessageFromRequest(req) }, auth.signature);
      if (signer !== req.payment_address) return fail(c, "unauthenticated", "signature does not recover to the payment address");
      nonce = auth.nonce;
    }

    const result = await deps.shadow.signup(req.payment_address, deps.now(), nonce);
    if (result.kind === "replayed") return fail(c, "unauthenticated", "nonce already used");
    if (result.kind === "closed") {
      log({ event: "shadow-signup-closed", customerId: result.customerId });
      return fail(c, "shadow_closed", CLOSED);
    }
    log({ event: "shadow-signup", customerId: result.customerId, scope: result.scope, admin: nonce === undefined });
    // The key is shown once: never cache this response.
    c.header("Cache-Control", "no-store");
    return c.json({ customerId: result.customerId, scope: result.scope, apiKey: result.apiKey } satisfies ShadowSignupResponse, 200);
  });

  app.post("/v1/shadow/check", async (c) => {
    // A client IP that already spent its failed-key budget this window is refused before any key lookup.
    const ip = ipOf(c);
    if (badKeyLimiter.exhausted(ip, deps.now().getTime())) {
      log({ event: "shadow-key-rate-limited" });
      return limited(c, badKeyLimiter, "too many invalid API keys from this client; retry after the current minute");
    }
    const key = c.req.header(API_KEY_HEADER);
    const owner = key === undefined || key.length === 0 ? undefined : await deps.shadow.resolveKey(key);
    if (owner === undefined) {
      badKeyLimiter.take(ip, deps.now().getTime());
      return fail(c, "unauthenticated", `a valid ${API_KEY_HEADER} is required`);
    }

    const raw = await jsonBody(c);
    if (!raw.ok) return fail(c, "validation_failed", "request body must be JSON");
    const parsed = ShadowCheckRequest.safeParse(raw.body);
    if (!parsed.success) return fail(c, "validation_failed", describeIssues(parsed.error));

    // Keyed `shadow:<customerId>` (the pipeline's shadow principal).
    const admit = (p: CheckPrincipal): boolean => limiter.take(p.kind === "advisory" ? `shadow:${owner.customerId}` : `shadow:${p.customerId}`, deps.now().getTime());
    const outcome = await runShadowCheck(parsed.data, owner, deps.check, { admit });
    if (outcome.kind === "rate_limited") {
      log({ event: "check-rate-limited", principal: "shadow" });
      c.header("Retry-After", String(Math.max(1, Math.ceil(limiter.msUntilReset(deps.now().getTime()) / 1000))));
      return fail(c, "rate_limited", "too many Checks; retry after the current minute");
    }
    if (outcome.kind === "shadow_closed") return fail(c, "shadow_closed", CLOSED);
    c.header("Cache-Control", "no-store");
    const body: ShadowCheckResponse = {
      ...outcome.response,
      outcome: shadowOutcome({ scope: outcome.scope, decision: outcome.response.decision, simulated: outcome.response.simulated }),
    };
    return c.json(body, 200);
  });
}
