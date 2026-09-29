// Pure Decision Record builder (AD-9, AD-10, AD-25, FR-26). Turns an `Evaluation` plus its context into
// a validated DecisionRecord v1. `simulated` and `advisory` are derived from provenance here; callers
// cannot pass them. No I/O, clock or randomness: `id` and `createdAt` arrive in the context.
import {
  DecisionRecord,
  toBaseUnits,
  type ChainState,
  type DeclaredIdentity,
  type Hex,
  type Scope,
  type Trigger,
} from "@horos/schema";
import { isSimulated } from "../evaluate/simulated.js";
import type { ChainView, Evaluation } from "../evaluate/types.js";

export type ScopeKind = "enforced" | "shadow" | "advisory-public";

/** The kind of an AD-25 Scope string (`enforced:<uuid>` | `shadow:<uuid>` | `advisory-public`). */
export function scopeKind(scope: string): ScopeKind {
  if (scope === "advisory-public") return "advisory-public";
  if (scope.startsWith("enforced:")) return "enforced";
  if (scope.startsWith("shadow:")) return "shadow";
  throw new RangeError(`unknown scope kind: ${scope}`);
}

/** How the Check reached Horos. An `x402` Check is always advisory, whatever its Scope. */
export type RecordChannel = "api" | "x402" | "worker";

export interface RecordContext {
  /** UUIDv7 minted by the caller (adapters own randomness). */
  readonly id: string;
  readonly scope: Scope;
  /** Wire time `YYYY-MM-DDTHH:mm:ss.SSSZ`, supplied by the caller (core has no clock). */
  readonly createdAt: string;
  readonly trigger: Trigger;
  readonly channel: RecordChannel;
  readonly customerId: string;
  /** Recorded for enforced Scopes only; required there. */
  readonly policyWallet?: string;
  readonly counterparty: string;
  /** Positive USDC base units, when the Decision was about a payment amount. */
  readonly amount?: bigint;
  readonly declaredIdentity?: DeclaredIdentity;
  /** Questions not asked (e.g. identity questions without a Declared Identity), in core order. */
  readonly skippedQuestions: readonly string[];
  readonly questionSetVersion: string;
  readonly policyVersionId: string;
  readonly presetVersion: string;
  /** The live (or mirrored) chain view the Decision used; `limitBefore` is its Limit when registered. */
  readonly chainView?: Pick<ChainView, "registered" | "limit">;
  readonly chainState: ChainState;
  readonly evaluation: Evaluation;
}

const BPS_SCALE = 10_000;

/** Integer basis points in [0, 10000] → the record's `"0.dddd"` / `"1.0000"`. */
export function confidenceFromBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_SCALE) throw new RangeError("confidence must be integer bps in [0, 10000]");
  return bps === BPS_SCALE ? "1.0000" : `0.${String(bps).padStart(4, "0")}`;
}

/**
 * Build the DecisionRecord at `(seq, prevHash)`. Synchronous and pure, so the record store can call it
 * while holding the Scope head lock. Throws `ZodError` when the result violates the schema or its invariants.
 */
export function buildDecisionRecord(ctx: RecordContext, seq: number, prevHash: Hex): DecisionRecord {
  const e = ctx.evaluation;
  const kind = scopeKind(ctx.scope);
  const advisory = kind !== "enforced" || ctx.channel === "x402";
  const record = {
    schemaVersion: 1,
    id: ctx.id,
    scope: ctx.scope,
    seq,
    prevHash,
    createdAt: ctx.createdAt,
    trigger: ctx.trigger,
    customerId: ctx.customerId,
    ...(kind === "enforced" && ctx.policyWallet !== undefined ? { policyWallet: ctx.policyWallet } : {}),
    counterparty: ctx.counterparty,
    ...(ctx.amount === undefined ? {} : { amount: toBaseUnits(ctx.amount) }),
    ...(ctx.declaredIdentity === undefined ? {} : { declaredIdentity: { status: "unverified", value: ctx.declaredIdentity } }),
    hardRules: e.hardRules.map((h) => ({ ...h })),
    signals: e.signals.map((s) => ({ ...s })),
    skippedQuestions: [...ctx.skippedQuestions],
    riskTier: e.riskTier,
    confidence: confidenceFromBps(e.confidenceBps),
    questionSetVersion: ctx.questionSetVersion,
    policyVersionId: ctx.policyVersionId,
    presetVersion: ctx.presetVersion,
    decision: e.decision,
    reason: e.reason,
    ...(ctx.chainView?.registered === true ? { limitBefore: toBaseUnits(ctx.chainView.limit) } : {}),
    targetLimit: toBaseUnits(e.targetLimit),
    chainState: ctx.chainState,
    simulated: isSimulated(e),
    advisory,
  };
  return DecisionRecord.parse(record);
}
