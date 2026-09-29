// Horos HTTP API (Hono). Story 2.2: `POST /v1/policy-versions` (FR-13, FR-14, AD-14, AD-17).
// Story 2.6: onboarding, bind and webhook updates (./onboarding.ts), mounted when their deps are given.
// Story 2.8: read-only records and Counterparty statuses (./reads.ts), mounted when `reads` is given.
// Story 2.9: `POST /v1/check` (./check.ts), mounted when `check` is given.
// Unknown routes answer 404 `not_found` and uncaught errors 500 `internal`, both as the AD-17 envelope.
import { createHash, timingSafeEqual } from "node:crypto";
import { SeqConflictError, decideActivation, type AccountStore, type ChainReader, type PolicyVersionStore, type ReadStore } from "@horos/core";
import {
  CreatePolicyVersionRequest,
  PolicyVersion,
  Scope,
  UuidV7,
  toWireTime,
} from "@horos/schema";
import { Hono, type Context } from "hono";
import type { HorosTx } from "@horos/adapters";
import type { CheckDeps } from "@horos/pipeline";
import { registerCheckRoute } from "./check.js";
import { describeIssues, fail } from "./http.js";
import { registerOnboardingRoutes } from "./onboarding.js";
import { registerReadRoutes } from "./reads.js";

export interface AppDeps {
  readonly policyVersions: PolicyVersionStore;
  /** Admin bearer token for policy writes. Comes from validated env; never logged. */
  readonly adminToken: string;
  readonly now: () => Date;
  /** Produces a fresh lowercase UUIDv7. */
  readonly newId: () => string;
  /** Onboarding (Story 2.6). The onboarding routes are mounted only when `accounts`, `chainReader` and `chainId` are all set. */
  readonly accounts?: AccountStore;
  readonly chainReader?: ChainReader;
  readonly chainId?: number;
  /** How long `POST /v1/onboarding` waits for provisioned keys. Default 8000 ms. */
  readonly provisionWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Read-only records and statuses (Story 2.8). The read routes are mounted only when set. */
  readonly reads?: ReadStore;
  /** A Scope readable without auth (the Horos Demo wallet's). */
  readonly publicDemoScope?: string;
  /** Maps an `x-horos-api-key` to its shadow Scope. Absent: API keys are refused. */
  readonly resolveShadowKey?: (key: string) => Promise<string | undefined>;
  /** Structured log sink; entries never carry secrets or webhook query strings. */
  readonly log?: (entry: Record<string, unknown>) => void;
  /** Sink for uncaught handler errors (the entry carries the raw error: the sink must redact). Default `log`. */
  readonly logError?: (entry: Record<string, unknown>) => void;
  /** The Check pipeline's ports (Story 2.9). `POST /v1/check` is mounted only when set. */
  readonly check?: CheckDeps<HorosTx>;
  /** Checks per minute per Customer or client IP. Default 120. */
  readonly checkRatePerMinute?: number;
  /** The socket's remote address, for the advisory rate-limit key when there is no `x-forwarded-for`. */
  readonly remoteAddress?: (c: Context) => string | undefined;
  /** Trusted reverse proxies appending to `x-forwarded-for`. Default 0: the header is ignored for rate limiting. */
  readonly trustedProxyHops?: number;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Constant-time bearer check (hashing first hides the token length). */
function bearerMatches(header: string | undefined, expectedDigest: Buffer): boolean {
  const presented = /^Bearer (.+)$/i.exec(header ?? "")?.[1] ?? "";
  return timingSafeEqual(sha256(presented), expectedDigest);
}

export function createApp(deps: AppDeps): Hono {
  if (deps.adminToken.length === 0) throw new Error("adminToken must be non-empty");
  if (deps.publicDemoScope !== undefined && !Scope.safeParse(deps.publicDemoScope).success) {
    throw new Error("publicDemoScope must be a valid Scope id");
  }
  const adminDigest = sha256(deps.adminToken);
  const app = new Hono();

  // AD-17: every response, unknown routes and uncaught errors included, is the error envelope. An uncaught error
  // answers a fixed message: its text may quote an RPC URL carrying an API key, so it only reaches the (redacting) log.
  const logError = deps.logError ?? deps.log;
  app.notFound((c) => fail(c, "not_found", "no such route"));
  app.onError((err, c) => {
    logError?.({ event: "unhandled-error", method: c.req.method, path: c.req.path, error: err });
    return fail(c, "internal", "internal error");
  });

  app.post("/v1/policy-versions", async (c) => {
    if (!bearerMatches(c.req.header("authorization"), adminDigest)) {
      return fail(c, "unauthenticated", "missing or invalid admin bearer token");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, "validation_failed", "request body must be JSON");
    }
    const parsed = CreatePolicyVersionRequest.safeParse(body);
    if (!parsed.success) return fail(c, "validation_failed", describeIssues(parsed.error));
    const request = parsed.data;

    const active = await deps.policyVersions.active(request.scope);
    const decision = decideActivation(active, request);
    if (!decision.ok) return fail(c, "validation_failed", decision.reason, { status: 422 });

    const row = PolicyVersion.parse({
      id: UuidV7.parse(deps.newId()),
      scope: request.scope,
      seq: decision.seq,
      ...(decision.parentId === undefined ? {} : { parentId: decision.parentId }),
      presetVersion: request.presetVersion,
      activation: decision.activation,
      policy: request.policy,
      createdAt: toWireTime(deps.now()),
    });
    try {
      await deps.policyVersions.insert(row);
    } catch (err) {
      if (err instanceof SeqConflictError) {
        return fail(c, "conflict", "the active policy version changed concurrently; re-read and retry", { retryable: true });
      }
      throw err;
    }
    return c.json(row, 201);
  });

  if (deps.accounts !== undefined && deps.chainReader !== undefined && deps.chainId !== undefined) {
    registerOnboardingRoutes(app, {
      accounts: deps.accounts,
      chainReader: deps.chainReader,
      chainId: deps.chainId,
      now: deps.now,
      isAdmin: (c) => bearerMatches(c.req.header("authorization"), adminDigest),
      ...(deps.provisionWaitMs === undefined ? {} : { provisionWaitMs: deps.provisionWaitMs }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  if (deps.reads !== undefined) {
    registerReadRoutes(app, {
      reads: deps.reads,
      now: deps.now,
      ...(deps.accounts === undefined ? {} : { accounts: deps.accounts }),
      ...(deps.chainReader === undefined ? {} : { chainReader: deps.chainReader }),
      ...(deps.chainId === undefined ? {} : { chainId: deps.chainId }),
      ...(deps.publicDemoScope === undefined ? {} : { publicDemoScope: deps.publicDemoScope }),
      ...(deps.resolveShadowKey === undefined ? {} : { resolveShadowKey: deps.resolveShadowKey }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  if (deps.check !== undefined) {
    registerCheckRoute(app, {
      check: deps.check,
      now: deps.now,
      ...(deps.checkRatePerMinute === undefined ? {} : { checkRatePerMinute: deps.checkRatePerMinute }),
      ...(deps.remoteAddress === undefined ? {} : { remoteAddress: deps.remoteAddress }),
      ...(deps.trustedProxyHops === undefined ? {} : { trustedProxyHops: deps.trustedProxyHops }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  return app;
}
