// Onboarding endpoints (AD-11, AD-15, AD-25, Story 2.6):
//   POST /v1/onboarding       Customer + first webhook + pending enforced binding + provision-keys job
//   POST /v1/onboarding/bind  bind a deployed PolicyWallet after checking its live roles
//   PUT  /v1/webhook          replace the webhook URL, signed by the live Payment key (verified before the binding
//                             lookup; "not bound" answers the same 401 as a bad signature)
// Onboard and Bind are signed by the Payment key (EIP-712 "Horos Account") or carry the admin bearer.
// Webhook URLs reach logs and errors only as `origin + pathname`.
import { BindingConflictError, recoverAccountSigner, ScopeMismatchError, type AccountTypedMessage } from "@horos/adapters";
import type { AccountStore, Binding, ChainReader, WalletRoles } from "@horos/core";
import {
  accountDomain,
  accountExpiryValid,
  bindMessageFromRequest,
  BindRequest,
  onboardMessageFromRequest,
  OnboardingRequest,
  redactUrl,
  webhookUpdateMessageFromRequest,
  WebhookUpdateRequest,
  type AccountAuth,
  type Hex,
  type OnboardingResponse,
} from "@horos/schema";
import type { Context, Hono } from "hono";
import { describeIssues, fail } from "./http.js";

export interface OnboardingDeps {
  readonly accounts: AccountStore;
  readonly chainReader: ChainReader;
  readonly chainId: number;
  /** How long `POST /v1/onboarding` waits for the worker to provision keys. Default 8000 ms. */
  readonly provisionWaitMs?: number;
  /** Poll interval while waiting. Default 250 ms. */
  readonly provisionPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now: () => Date;
  /** True when the request carries the valid admin bearer token. */
  readonly isAdmin: (c: Context) => boolean;
  /** Structured log sink. Entries never carry secrets, signatures or webhook query strings. */
  readonly log?: (entry: Record<string, unknown>) => void;
}

async function jsonBody(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function response(b: Binding): OnboardingResponse {
  const status = b.status === "bound" ? "bound" : b.keys === null ? "provisioning" : "provisioned";
  return {
    customerId: b.customerId,
    scope: b.scopeId,
    status,
    registrar: b.keys?.registrar.address ?? null,
    model: b.keys?.model.address ?? null,
    rules: b.keys?.rules.address ?? null,
    ...(b.policyWallet === null ? {} : { policyWallet: b.policyWallet }),
  };
}

/** The first role (in `payment|registrar|model|rules|human` order) that does not match, or undefined. */
export function firstMismatchedRole(roles: WalletRoles, paymentAddress: Hex, keys: NonNullable<Binding["keys"]>): string | undefined {
  if (roles.payment !== paymentAddress) return "payment";
  if (roles.registrar !== keys.registrar.address) return "registrar";
  if (roles.model !== keys.model.address) return "model";
  if (roles.rules !== keys.rules.address) return "rules";
  const human = roles.human;
  if (human === `0x${"0".repeat(40)}` || [roles.payment, roles.registrar, roles.model, roles.rules].includes(human)) return "human";
  return undefined;
}

export function registerOnboardingRoutes(app: Hono, deps: OnboardingDeps): void {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.provisionWaitMs ?? 8000;
  const pollMs = Math.max(1, deps.provisionPollMs ?? 250);
  const domain = accountDomain(deps.chainId);
  const log = deps.log ?? (() => {});

  /** Admin bearer, or a fresh signature that recovers to `expected`. A present-but-wrong bearer fails. */
  async function authorised(c: Context, auth: AccountAuth | undefined, typed: () => AccountTypedMessage, expected: Hex): Promise<string | undefined> {
    if (c.req.header("authorization") !== undefined) return deps.isAdmin(c) ? undefined : "missing or invalid admin bearer token";
    if (auth === undefined) return "a signed auth envelope or the admin bearer token is required";
    if (!accountExpiryValid(auth.expiry, deps.now())) return "auth expiry must be in the future and at most 300 seconds away";
    const signer = await recoverAccountSigner(domain, typed(), auth.signature);
    return signer === expected ? undefined : "signature does not recover to the payment address";
  }

  app.post("/v1/onboarding", async (c) => {
    const raw = await jsonBody(c);
    if (!raw.ok) return fail(c, "validation_failed", "request body must be JSON");
    const parsed = OnboardingRequest.safeParse(raw.body);
    if (!parsed.success) return fail(c, "validation_failed", describeIssues(parsed.error));
    const req = parsed.data;
    const denied = await authorised(c, req.auth, () => ({ primaryType: "Onboard", message: onboardMessageFromRequest(req) }), req.payment_address);
    if (denied !== undefined) return fail(c, "unauthenticated", denied);

    const webhookUrl = req.webhook_url ?? "";
    const { binding, created } = await deps.accounts.onboard({ paymentAddress: req.payment_address, webhookUrl, now: deps.now() });
    log({ event: "onboarding", customerId: binding.customerId, scope: binding.scopeId, created, webhook: redactUrl(webhookUrl) });

    let current = binding;
    for (let waited = 0; current.keys === null && waited < waitMs; waited += pollMs) {
      await sleep(pollMs);
      current = (await deps.accounts.bindingByPayment(req.payment_address)) ?? current;
    }
    return c.json(response(current), current.keys === null ? 202 : 200);
  });

  app.post("/v1/onboarding/bind", async (c) => {
    const raw = await jsonBody(c);
    if (!raw.ok) return fail(c, "validation_failed", "request body must be JSON");
    const parsed = BindRequest.safeParse(raw.body);
    if (!parsed.success) return fail(c, "validation_failed", describeIssues(parsed.error));
    const req = parsed.data;
    const denied = await authorised(c, req.auth, () => ({ primaryType: "Bind", message: bindMessageFromRequest(req) }), req.payment_address);
    if (denied !== undefined) return fail(c, "unauthenticated", denied);

    const binding = await deps.accounts.bindingByPayment(req.payment_address);
    if (binding === undefined) return fail(c, "not_found", "no onboarding exists for this payment address");
    if (binding.keys === null) return fail(c, "conflict", "keys are still provisioning; retry shortly", { retryable: true });
    if (binding.status === "bound") {
      if (binding.policyWallet === req.policy_wallet) return c.json(response(binding), 200);
      return fail(c, "conflict", "this customer is already bound to a different PolicyWallet");
    }

    let roles: WalletRoles;
    try {
      if (!(await deps.chainReader.hasCode(req.policy_wallet))) return fail(c, "validation_failed", "policy_wallet has no contract code", { status: 422 });
      roles = await deps.chainReader.roles(req.policy_wallet);
    } catch {
      return fail(c, "unavailable", "could not read the PolicyWallet's live roles; retry shortly");
    }
    const mismatch = firstMismatchedRole(roles, binding.paymentAddress, binding.keys);
    if (mismatch !== undefined) {
      return fail(c, "validation_failed", `role mismatch: ${mismatch}`, { status: 422 });
    }
    try {
      const bound = await deps.accounts.bind(binding.customerId, req.policy_wallet, deps.now());
      log({ event: "onboarding-bound", customerId: bound.customerId, scope: bound.scopeId, policyWallet: req.policy_wallet });
      return c.json(response(bound), 200);
    } catch (err) {
      if (err instanceof BindingConflictError || err instanceof ScopeMismatchError) {
        return fail(c, "conflict", "this PolicyWallet or customer is already bound elsewhere");
      }
      throw err;
    }
  });

  app.put("/v1/webhook", async (c) => {
    const raw = await jsonBody(c);
    if (!raw.ok) return fail(c, "validation_failed", "request body must be JSON");
    const parsed = WebhookUpdateRequest.safeParse(raw.body);
    if (!parsed.success) return fail(c, "validation_failed", describeIssues(parsed.error));
    const req = parsed.data;
    if (!accountExpiryValid(req.auth.expiry, deps.now())) {
      return fail(c, "unauthenticated", "auth expiry must be in the future and at most 300 seconds away");
    }
    // Verify the signature against the live Payment key before looking up the binding, and answer "bad signature"
    // and "not bound" alike, so the endpoint does not reveal which wallets are bound (AD-17).
    let roles: WalletRoles;
    try {
      roles = await deps.chainReader.roles(req.policy_wallet);
    } catch {
      return fail(c, "unavailable", "could not read the PolicyWallet's live roles; retry shortly");
    }
    const signer = await recoverAccountSigner(
      domain,
      { primaryType: "WebhookUpdate", message: webhookUpdateMessageFromRequest(req) },
      req.auth.signature,
    );
    const invalid = "signature does not recover to the live Payment key of a bound PolicyWallet";
    if (signer === undefined || signer !== roles.payment) return fail(c, "unauthenticated", invalid);
    const binding = await deps.accounts.bindingByWallet(req.policy_wallet);
    if (binding?.status !== "bound") return fail(c, "unauthenticated", invalid);
    const ok = await deps.accounts.updateWebhook(binding.customerId, roles.payment, req.auth.nonce, req.webhook_url, deps.now());
    if (!ok) return fail(c, "unauthenticated", "nonce already used");
    const webhook = redactUrl(req.webhook_url);
    log({ event: "webhook-updated", customerId: binding.customerId, scope: binding.scopeId, webhook });
    return c.json({ customerId: binding.customerId, webhook }, 200);
  });
}
