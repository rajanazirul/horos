// One Check, end to end (Story 2.9; FR-1, FR-2, FR-3, FR-11, NFR-1, NFR-2, AD-1, AD-3, AD-4, AD-11):
//   authenticate → chain reads (failover in the reader, mirror fallback here) → lists and Policy → core
//   `evaluate` → one-transaction record + nonce + outbox append → `limit_write` wait.
// Only an authenticated Check (signed by the wallet's live Payment key) can write an outbox intent; anything
// else runs in the advisory-public Scope. Nothing here writes to the chain.
import {
  buildDecisionRecord,
  evaluate,
  fromOffchainPolicy,
  identityKeys,
  NonceReplayError,
  type Binding,
  type ChainInput,
  type Evaluation,
  type LivePolicy,
  type WalletRoles,
  type ChainView,
} from "@horos/core";
import {
  ADVISORY_PUBLIC_CUSTOMER_ID,
  checkDomain,
  checkMessageFromRequest,
  CheckResponse,
  MAX_CHECK_EXPIRY_SECONDS,
  toBaseUnits,
  toWireTime,
  type ChainState,
  type CheckRequest,
  type Hex,
  type LimitWrite,
  type PolicyVersion,
  Scope,
} from "@horos/schema";
import type { AdvisoryReason, CheckDeps, CheckPrincipal } from "./ports.js";

export const ADVISORY_PUBLIC_SCOPE = "advisory-public";
export const DEFAULT_LIMIT_WRITE_WAIT_MS = 2000;
export const LIMIT_WRITE_POLL_MS = 100;

export interface RunCheckOptions {
  /**
   * Rate-limit gate, called once the Check's principal is known and before anything is written. Returning
   * false ends the Check as `rate_limited` with nothing written.
   */
  readonly admit?: (principal: CheckPrincipal) => boolean;
}

export type CheckOutcome =
  | {
      readonly kind: "decided";
      readonly response: CheckResponse;
      readonly scope: Scope;
      readonly evaluation: Evaluation;
      /** Set when the Check ran advisory-public. */
      readonly advisoryReason?: AdvisoryReason;
    }
  | { readonly kind: "rate_limited"; readonly principal: CheckPrincipal };

/** @internal */
export type Auth =
  | {
      readonly kind: "enforced";
      readonly scope: Scope;
      readonly customerId: string;
      readonly nonce: Hex;
      /** False when both RPCs failed on `roles` and the signer matched the stored Payment address. */
      readonly rolesLive: boolean;
    }
  | { readonly kind: "advisory"; readonly reason: AdvisoryReason };

/** @internal */
export interface LiveReads {
  readonly remaining: PromiseSettledResult<ChainView>;
  readonly policy: PromiseSettledResult<LivePolicy>;
  readonly hasCode: PromiseSettledResult<boolean>;
}

const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> =>
  p.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason: unknown) => ({ status: "rejected", reason }) as const,
  );

async function authenticate<Tx>(
  req: CheckRequest,
  deps: CheckDeps<Tx>,
  nowMs: number,
  binding: Binding | undefined,
  roles: () => Promise<PromiseSettledResult<WalletRoles>>,
): Promise<Auth> {
  const auth = req.auth;
  if (auth === undefined) return { kind: "advisory", reason: "unsigned" };
  const expiryMs = Date.parse(auth.expiry);
  if (!(expiryMs > nowMs) || expiryMs - nowMs > MAX_CHECK_EXPIRY_SECONDS * 1000) return { kind: "advisory", reason: "expired" };
  let signer: Hex | undefined;
  try {
    signer = await deps.recoverCheckSigner(checkDomain(deps.chainId, req.policy_wallet), checkMessageFromRequest(req), auth.signature);
  } catch {
    signer = undefined;
  }
  if (signer === undefined) return { kind: "advisory", reason: "bad-signature" };
  if (!isBound(binding, req.policy_wallet)) return { kind: "advisory", reason: "unbound" };
  const scope = Scope.parse(binding.scopeId);
  if (await deps.nonceUsed(scope, auth.nonce)) return { kind: "advisory", reason: "replayed" };
  const live = await roles();
  if (live.status === "fulfilled") {
    if (live.value.payment !== signer) return { kind: "advisory", reason: "wrong-signer" };
    return { kind: "enforced", scope, customerId: binding.customerId, nonce: auth.nonce, rolesLive: true };
  }
  // Both RPCs failed on roles: fall back to the Payment address verified at bind, and run stale.
  if (binding.paymentAddress !== signer) return { kind: "advisory", reason: "wrong-signer" };
  return { kind: "enforced", scope, customerId: binding.customerId, nonce: auth.nonce, rolesLive: false };
}

function isBound(binding: Binding | undefined, wallet: Hex): binding is Binding {
  return binding !== undefined && binding.status === "bound" && binding.policyWallet === wallet;
}

/**
 * The chain input and state for core: live when every read succeeded, else the mirror (enforced only) or nothing.
 * Exported for tests only (not from the package index).
 */
export async function chainInput<Tx>(
  deps: CheckDeps<Tx>,
  auth: Auth,
  counterparty: Hex,
  reads: LiveReads,
): Promise<{ readonly chain?: ChainInput; readonly chainState: ChainState }> {
  const { remaining, policy, hasCode } = reads;
  const rolesOk = auth.kind !== "enforced" || auth.rolesLive;
  if (rolesOk && remaining.status === "fulfilled" && policy.status === "fulfilled" && hasCode.status === "fulfilled") {
    return {
      chain: { view: remaining.value, payeeIsContract: hasCode.value, firstContactCeiling: policy.value.firstContactCeiling },
      chainState: "live",
    };
  }
  if (auth.kind !== "enforced") return { chainState: "stale" };
  const m = await deps.mirror(auth.scope, counterparty);
  if (m === undefined) return { chainState: "stale" };
  // The mirror knows the Limit but not the rolling-window spend: every remaining budget is 0 (AD-3, NFR-2).
  return {
    chain: {
      view: {
        cpRemaining: 0n,
        walletRemaining: 0n,
        newPayeeRemaining: 0n,
        limit: m.limit,
        pinned: m.pinned,
        registered: m.registered,
        humanSet: m.humanSet,
        humanEpoch: m.humanEpoch,
      },
      // A contract payee holds on first contact: without a live answer assume the conservative value.
      payeeIsContract: hasCode.status === "fulfilled" ? hasCode.value : true,
      firstContactCeiling: 0n,
    },
    chainState: "stale",
  };
}

async function policyFor<Tx>(deps: CheckDeps<Tx>, scope: string): Promise<PolicyVersion> {
  const active = await deps.activePolicy(scope);
  if (active !== undefined) return active;
  await deps.ensurePresetPolicy(scope);
  const created = await deps.activePolicy(scope);
  if (created === undefined) throw new Error(`no PolicyVersion for scope ${scope} after ensuring the preset`);
  return created;
}

async function waitForLimitWrite<Tx>(deps: CheckDeps<Tx>, scope: string, counterparty: Hex, recordId: string): Promise<LimitWrite> {
  const configured = deps.limitWriteWaitMs ?? DEFAULT_LIMIT_WRITE_WAIT_MS;
  const budget = Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_LIMIT_WRITE_WAIT_MS;
  const deadline = deps.now().getTime() + budget;
  let state = await deps.intentState(scope, counterparty, recordId);
  while ((state === "pending" || state === "coalesced") && deps.now().getTime() < deadline) {
    await deps.sleep(Math.min(LIMIT_WRITE_POLL_MS, deadline - deps.now().getTime()));
    state = await deps.intentState(scope, counterparty, recordId);
  }
  return state;
}

/**
 * Run one Check. `req` must already be a parsed `CheckRequest` (validation failures never reach here, so
 * they write nothing and consume no nonce). Throws on infrastructure failures (e.g. the database).
 */
export async function runCheck<Tx>(req: CheckRequest, deps: CheckDeps<Tx>, opts: RunCheckOptions = {}): Promise<CheckOutcome> {
  return run(req, deps, opts, false);
}

async function run<Tx>(req: CheckRequest, deps: CheckDeps<Tx>, opts: RunCheckOptions, forceAdvisory: boolean): Promise<CheckOutcome> {
  const now = deps.now();
  const nowMs = now.getTime();
  const wallet = req.policy_wallet;
  const a = req.counterparty;

  // Rate limiting comes first: a refused Check costs one binding lookup and no RPC call. A signed Check naming a
  // bound wallet counts against that Customer; everything else against the advisory (client IP) key.
  const binding = !forceAdvisory && req.auth !== undefined ? await deps.bindingByWallet(wallet) : undefined;
  const principal: CheckPrincipal = isBound(binding, wallet) ? { kind: "customer", customerId: binding.customerId } : { kind: "advisory" };
  if (!forceAdvisory && opts.admit !== undefined && !opts.admit(principal)) return { kind: "rate_limited", principal };

  // Live reads start now, alongside the local signature check (the reader fails over primary → secondary).
  const remaining = settle(deps.chain.remaining(wallet, a));
  const livePolicy = settle(deps.chain.policy(wallet));
  const hasCode = settle(deps.chain.hasCode(a));
  let rolesRead: Promise<PromiseSettledResult<WalletRoles>> | undefined;
  const roles = () => (rolesRead ??= settle(deps.chain.roles(wallet)));
  if (isBound(binding, wallet)) void roles();

  const auth: Auth = forceAdvisory ? { kind: "advisory", reason: "nonce-race" } : await authenticate(req, deps, nowMs, binding, roles);

  const scope: Scope = auth.kind === "enforced" ? auth.scope : ADVISORY_PUBLIC_SCOPE;
  const reads: LiveReads = { remaining: await remaining, policy: await livePolicy, hasCode: await hasCode };
  // History and identity bindings only count in an enforced Scope: advisory-public input is anonymous, so one
  // caller must not be able to change another's result. Only records sharing an identity key are read.
  const keys = identityKeys(req.declared_identity);
  const [{ chain, chainState }, lists, policyVersion, pendingIntentTarget, hasHistory, identityBindings] = await Promise.all([
    chainInput(deps, auth, a, reads),
    deps.lists(),
    policyFor(deps, scope),
    auth.kind === "enforced" ? deps.pendingIntentTarget(scope, a) : Promise.resolve(undefined),
    auth.kind === "enforced" ? deps.hasHistory(scope, a) : Promise.resolve(false),
    auth.kind === "enforced" && keys.length > 0 ? deps.identityBindings(scope, keys) : Promise.resolve([]),
  ]);

  const evaluation = evaluate({
    counterparty: a,
    amount: BigInt(req.amount),
    ...(req.declared_identity === undefined ? {} : { declaredIdentity: req.declared_identity }),
    now: nowMs,
    lists,
    ...(chain === undefined ? {} : { chain }),
    chainState,
    hasHistory,
    identityBindings,
    ...(pendingIntentTarget === undefined ? {} : { pendingIntentTarget }),
    policy: fromOffchainPolicy(policyVersion.policy),
  });

  const recordId = deps.newId();
  const ctx = {
    id: recordId,
    scope,
    createdAt: toWireTime(now),
    trigger: "check",
    channel: "api",
    customerId: auth.kind === "enforced" ? auth.customerId : ADVISORY_PUBLIC_CUSTOMER_ID,
    ...(auth.kind === "enforced" ? { policyWallet: wallet } : {}),
    counterparty: a,
    amount: BigInt(req.amount),
    ...(req.declared_identity === undefined ? {} : { declaredIdentity: req.declared_identity }),
    skippedQuestions: [],
    questionSetVersion: policyVersion.policy.questionSetVersion,
    policyVersionId: policyVersion.id,
    presetVersion: policyVersion.presetVersion,
    ...(chain === undefined ? {} : { chainView: chain.view }),
    chainState,
    evaluation,
  } as const;

  if (auth.kind !== "enforced") await deps.ensureAdvisoryScope();
  let appended;
  try {
    appended = await deps.records.append({
      scope,
      build: (seq, prevHash) => buildDecisionRecord(ctx, seq, prevHash),
      ...(auth.kind === "enforced"
        ? { nonce: auth.nonce, extraWrites: deps.outboxWrites(evaluation, { now, humanEpoch: chain?.view.humanEpoch ?? 0n }) }
        : {}),
    });
  } catch (err) {
    // A concurrent Check won the nonce: this one re-runs as advisory-public (AD-11).
    if (err instanceof NonceReplayError && auth.kind === "enforced") return run(req, deps, opts, true);
    throw err;
  }
  const record = appended.record;

  const limitWrite: LimitWrite = auth.kind === "enforced" ? await waitForLimitWrite(deps, scope, a, recordId) : "none";
  const txHash = limitWrite === "confirmed" ? await deps.intentTxHash(scope, a, recordId) : undefined;

  const response = CheckResponse.parse({
    decision: evaluation.decision,
    effective_limit: toBaseUnits(evaluation.targetLimit),
    remaining: toBaseUnits(evaluation.remaining),
    reason: evaluation.reason,
    confidence: evaluation.confidenceBps / 10_000,
    record_id: recordId,
    simulated: "simulated" in record ? record.simulated : false,
    advisory: "advisory" in record ? record.advisory : true,
    ...(txHash === undefined ? {} : { tx_hash: txHash }),
    limit_write: limitWrite,
    chain_state: chainState,
    ...(evaluation.decision === "cap" && evaluation.payable !== undefined ? { payable_amount: toBaseUnits(evaluation.payable) } : {}),
    ...(auth.kind === "enforced" ? { questions: [] } : {}),
  });

  deps.log?.({
    event: "check",
    recordId,
    scope,
    trigger: "check",
    decision: response.decision,
    advisory: response.advisory,
    chainState,
    limitWrite,
    ...(auth.kind === "advisory" ? { advisoryReason: auth.reason } : {}),
  });

  return {
    kind: "decided",
    response,
    scope,
    evaluation,
    ...(auth.kind === "advisory" ? { advisoryReason: auth.reason } : {}),
  };
}
