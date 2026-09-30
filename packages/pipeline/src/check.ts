// One Check, end to end (Story 2.9; FR-1, FR-2, FR-3, FR-11, NFR-1, NFR-2, AD-1, AD-3, AD-4, AD-11):
//   authenticate → chain reads (failover in the reader, mirror fallback here) → lists and Policy → core
//   `evaluate` → one-transaction record + nonce + outbox append → `limit_write` wait.
// Only an authenticated Check (signed by the wallet's live Payment key) can write an outbox intent; anything
// else runs in the advisory-public Scope. Nothing here writes to the chain.
import {
  buildDecisionRecord,
  evaluate,
  findPreset,
  fromOffchainPolicy,
  ShadowClosedError,
  STANDARD_PRESET,
  identityKeys,
  NonceReplayError,
  type Binding,
  type ChainInput,
  type ExtraWrites,
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
  type ShadowCheckRequest,
  Scope,
} from "@horos/schema";
import type { AdvisoryReason, CheckDeps, CheckPrincipal, LedgerWindowPolicy } from "./ports.js";

/**
 * The virtual ledger's window Policy for a PolicyVersion: its Preset's on-chain values, the Standard Preset's when the
 * Preset is unknown. The same PolicyVersion drives `evaluate`, so the two never disagree.
 */
export function ledgerWindowPolicy(policyVersion: Pick<PolicyVersion, "presetVersion">): LedgerWindowPolicy {
  const onchain = (findPreset(policyVersion.presetVersion) ?? STANDARD_PRESET).onchain;
  return {
    firstContactCeiling: onchain.firstContactCeiling,
    walletPeriodCap: onchain.walletPeriodCap,
    newPayeeCap: BigInt(onchain.newPayeeCap),
    policyPeriodDays: BigInt(onchain.policyPeriodDays),
  };
}

export const ADVISORY_PUBLIC_SCOPE = "advisory-public";
/** 0: a Check does not wait for the limit write (NFR-1/AD-8 amendment 2026-09-29); it returns `limit_write: pending`. */
export const DEFAULT_LIMIT_WRITE_WAIT_MS = 0;
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

/** A shadow Check's outcome: decided, rate-limited, or refused because the Customer's PolicyWallet is bound. */
export type ShadowCheckOutcome =
  | Exclude<CheckOutcome, { readonly kind: "decided" }>
  | { readonly kind: "decided"; readonly response: CheckResponse; readonly scope: Scope; readonly evaluation: Evaluation }
  | { readonly kind: "shadow_closed" };

/** The Customer and shadow Scope an API key resolved to. */
export interface ShadowPrincipal {
  readonly customerId: string;
  readonly scope: string;
}

/** @internal */
export type Auth =
  | {
      readonly kind: "enforced";
      readonly scope: Scope;
      readonly customerId: string;
      readonly nonce: Hex;
      readonly policyWallet: Hex;
      /** False when both RPCs failed on `roles` and the signer matched the stored Payment address. */
      readonly rolesLive: boolean;
    }
  /** A shadow Check (Story 3.4): authenticated by an API key, answered from the virtual ledger, always advisory. */
  | { readonly kind: "shadow"; readonly scope: Scope; readonly customerId: string }
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
    return { kind: "enforced", scope, customerId: binding.customerId, nonce: auth.nonce, policyWallet: req.policy_wallet, rolesLive: true };
  }
  // Both RPCs failed on roles: fall back to the Payment address verified at bind, and run stale.
  if (binding.paymentAddress !== signer) return { kind: "advisory", reason: "wrong-signer" };
  return { kind: "enforced", scope, customerId: binding.customerId, nonce: auth.nonce, policyWallet: req.policy_wallet, rolesLive: false };
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
  if (auth.kind === "shadow") throw new Error("a shadow Check reads the virtual ledger, not the chain");
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

  const reads = (async (): Promise<LiveReads> => ({ remaining: await remaining, policy: await livePolicy, hasCode: await hasCode }))();
  const outcome = await decide(deps, auth, req, now, reads.then((r) => chainInput(deps, auth, a, r)), () => run(req, deps, opts, true));
  // Only a shadow Check can be closed.
  if (outcome.kind === "shadow_closed") throw new Error("an enforced or advisory Check cannot be shadow_closed");
  return outcome;
}

/** The request fields every Check kind shares. */
type CheckBody = Pick<CheckRequest, "counterparty" | "amount" | "declared_identity">;

/**
 * The common tail of every Check (enforced, shadow, advisory-public): inputs → core `evaluate` → one-transaction
 * append (enforced: nonce + outbox intent; shadow: the virtual-ledger effect; advisory: nothing) → response.
 */
async function decide<Tx>(
  deps: CheckDeps<Tx>,
  auth: Auth,
  req: CheckBody,
  now: Date,
  chainInputP: Promise<{ readonly chain?: ChainInput; readonly chainState: ChainState }>,
  onNonceRace: () => Promise<CheckOutcome>,
): Promise<Extract<CheckOutcome, { kind: "decided" }> | { readonly kind: "shadow_closed" }> {
  const nowMs = now.getTime();
  const a = req.counterparty;
  const scope: Scope = auth.kind === "advisory" ? ADVISORY_PUBLIC_SCOPE : auth.scope;
  // History and identity bindings only count in a Customer's own Scope (enforced, or its shadow Scope): advisory-public
  // input is anonymous, so one caller must not be able to change another's result. Only records sharing an identity key
  // are read. A shadow Scope's history is its virtual ledger; it has no outbox, so no pending intent.
  const keys = identityKeys(req.declared_identity);
  const ledger = deps.ledger;
  const history =
    auth.kind === "enforced"
      ? deps.hasHistory(scope, a)
      : auth.kind === "shadow" && ledger !== undefined
        ? ledger.hasHistory(scope, a)
        : Promise.resolve(false);
  const [{ chain, chainState }, lists, policyVersion, pendingIntentTarget, hasHistory, identityBindings] = await Promise.all([
    chainInputP,
    deps.lists(),
    policyFor(deps, scope),
    auth.kind === "enforced" ? deps.pendingIntentTarget(scope, a) : Promise.resolve(undefined),
    history,
    auth.kind !== "advisory" && keys.length > 0 ? deps.identityBindings(scope, keys) : Promise.resolve([]),
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
    customerId: auth.kind === "advisory" ? ADVISORY_PUBLIC_CUSTOMER_ID : auth.customerId,
    ...(auth.kind === "enforced" ? { policyWallet: auth.policyWallet } : {}),
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

  if (auth.kind === "advisory") await deps.ensureAdvisoryScope();
  let extra: { nonce?: string; extraWrites?: ExtraWrites<Tx> } = {};
  if (auth.kind === "enforced") {
    extra = { nonce: auth.nonce, extraWrites: deps.outboxWrites(evaluation, { now, humanEpoch: chain?.view.humanEpoch ?? 0n }) };
  } else if (auth.kind === "shadow") {
    if (ledger === undefined) throw new Error("a shadow Check needs the virtual ledger");
    // Virtual spend (AD-7): allow records the amount, cap the payable amount; hold and block spend nothing.
    const spend = evaluation.decision === "allow" ? BigInt(req.amount) : evaluation.decision === "cap" ? (evaluation.payable ?? 0n) : 0n;
    extra = {
      extraWrites: ledger.apply(
        scope,
        a,
        { ...(evaluation.outboxIntent === undefined ? {} : { intent: evaluation.outboxIntent }), spend },
        now,
        ledgerWindowPolicy(policyVersion),
      ),
    };
  }
  let appended;
  try {
    appended = await deps.records.append({ scope, build: (seq, prevHash) => buildDecisionRecord(ctx, seq, prevHash), ...extra });
  } catch (err) {
    // The Customer's PolicyWallet was bound after the pre-check: the append rolled back, nothing was written.
    if (err instanceof ShadowClosedError && auth.kind === "shadow") return { kind: "shadow_closed" };
    // A concurrent Check won the nonce: this one re-runs as advisory-public (AD-11).
    if (err instanceof NonceReplayError && auth.kind === "enforced") {
      const retried = await onNonceRace();
      if (retried.kind !== "decided") throw new Error("the advisory re-run of a nonce race must decide");
      return retried;
    }
    throw err;
  }
  const record = appended.record;

  // Only an enforced Check queues a chain write; shadow and advisory answers never do (`limit_write: none`).
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
    event: auth.kind === "shadow" ? "shadow-check" : "check",
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

/**
 * Run one shadow Check (Story 3.4, FR-28, AD-7, AD-25) for the Customer an API key resolved to. The same pipeline as
 * `runCheck`, in the Customer's `shadow:<customerId>` Scope: the chain input is the virtual view (the ledger's
 * `remaining(a)`, a live `hasCode(a)` and the shadow First-Contact Ceiling), the record is advisory, the ledger effect
 * commits with the record, and nothing is queued for the chain (`limit_write: none`, no `tx_hash`). No
 * `chain.remaining` / `chain.policy` / `chain.roles` read is made. Once the Customer's PolicyWallet is bound the answer
 * is `shadow_closed` and nothing is written. `req` must already be a parsed `ShadowCheckRequest`.
 */
export async function runShadowCheck<Tx>(
  req: ShadowCheckRequest,
  principal: ShadowPrincipal,
  deps: CheckDeps<Tx>,
  opts: RunCheckOptions = {},
): Promise<ShadowCheckOutcome> {
  const ledger = deps.ledger;
  if (ledger === undefined) throw new Error("runShadowCheck needs deps.ledger");
  const scope = Scope.parse(principal.scope);
  if (scope !== `shadow:${principal.customerId}`) throw new Error("the principal's scope is not its Customer's shadow Scope");
  const p: CheckPrincipal = { kind: "shadow", customerId: principal.customerId };
  if (opts.admit !== undefined && !opts.admit(p)) return { kind: "rate_limited", principal: p };
  if (await ledger.isClosed(principal.customerId)) return { kind: "shadow_closed" };

  const now = deps.now();
  const a = req.counterparty;
  const auth: Auth = { kind: "shadow", scope, customerId: principal.customerId };
  const hasCode = settle(deps.chain.hasCode(a));
  const input = (async () => {
    // The window Policy comes from the Scope's active PolicyVersion, the one `evaluate` uses.
    const windowPolicy = ledgerWindowPolicy(await policyFor(deps, scope));
    const [view, code] = await Promise.all([ledger.remaining(scope, a, now, windowPolicy), hasCode]);
    // Without a live hasCode answer, assume a contract payee (first contact holds) and say the view is not fully live.
    const chain: ChainInput = {
      view,
      payeeIsContract: code.status === "fulfilled" ? code.value : true,
      firstContactCeiling: windowPolicy.firstContactCeiling,
    };
    return { chain, chainState: code.status === "fulfilled" ? ("live" as const) : ("stale" as const) };
  })();
  return decide(deps, auth, req, now, input, () => Promise.reject(new Error("a shadow Check consumes no nonce")));
}
