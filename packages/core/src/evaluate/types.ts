// Inputs and outputs of the pure `evaluate()` (AD-2, AD-2a). Every fact arrives as an argument:
// `now`, list snapshots, the live chain view and the Policy. Money is bigint base units; confidence
// is integer basis points. No floats anywhere in the decision path.
import type {
  ChainState,
  Decision,
  DeclaredIdentity,
  HardRuleResult,
  Hex,
  ListSource,
  RiskTier,
  SignalResult,
} from "@horos/schema";
import type { CoreOffchainPolicy } from "../policy/preset.js";

/** One immutable list snapshot (OFAC SDN or the Horos Demo List). */
export interface ListSnapshot {
  readonly source: ListSource;
  readonly snapshotId: string;
  readonly snapshotHash: Hex;
  /** Lowercase `0x` address → entity names on that list entry. */
  readonly entries: ReadonlyMap<string, readonly string[]>;
  /** ms since epoch of the last successful poll (incl. 304). */
  readonly lastVerifiedAt: number;
}

/** `remaining(a)` as read from the PolicyWallet (AD-7). Core never does window arithmetic. */
export interface ChainView {
  readonly cpRemaining: bigint;
  readonly walletRemaining: bigint;
  readonly newPayeeRemaining: bigint;
  readonly limit: bigint;
  readonly pinned: boolean;
  readonly registered: boolean;
  readonly humanSet: boolean;
  readonly humanEpoch: bigint;
}

export interface ChainInput {
  readonly view: ChainView;
  readonly payeeIsContract: boolean;
  /** The live on-chain First-Contact Ceiling. */
  readonly firstContactCeiling: bigint;
}

/** An identity key already bound to an address in this Scope (see `identityKeys`). */
export interface IdentityBinding {
  readonly key: string;
  readonly address: string;
}

/** Exposure input shape only; Epic 5 computes it. */
export interface ExposureInput {
  readonly tierContribution: RiskTier;
  /** True when every exposure path is inbound (funds received from risky sources). */
  readonly inboundOnly: boolean;
}

/** One answered Graded Judgment question (Epic 4 supplies these; Epic 2 passes none). */
export interface JudgmentAnswer {
  readonly questionId: string;
  readonly tierContribution: RiskTier;
  /** The tier contribution had the answer gone the other way. */
  readonly flippedTierContribution: RiskTier;
  /** Integer basis points in [0, 10000]. */
  readonly confidenceBps: number;
}

export interface EvaluationInput {
  readonly counterparty: string;
  /** Positive USDC base units. */
  readonly amount: bigint;
  readonly declaredIdentity?: DeclaredIdentity;
  /** ms since epoch. */
  readonly now: number;
  readonly lists: readonly ListSnapshot[];
  /** Absent when neither RPC nor the indexer mirror has a view. */
  readonly chain?: ChainInput;
  readonly chainState: ChainState;
  readonly hasHistory: boolean;
  readonly identityBindings: readonly IdentityBinding[];
  readonly exposure?: ExposureInput;
  readonly judgment?: readonly JudgmentAnswer[];
  /** Target of an already-queued outbox intent for this Counterparty, if any. */
  readonly pendingIntentTarget?: bigint;
  readonly policy: CoreOffchainPolicy;
}

export interface JudgmentEvidence {
  readonly questionId: string;
  readonly tierContribution: RiskTier;
  readonly confidenceBps: number;
  /** True when this answer's confidence feeds Decision Confidence. */
  readonly counted: boolean;
}

export type StageName = "hard-rules" | "signals" | "judgment";

/** What each stage returns; only the Policy stage combines them (AD-2). */
export type StageOutcome =
  | {
      readonly stage: "hard-rules";
      readonly tierContribution: RiskTier;
      readonly ceiling?: bigint;
      readonly evidence: readonly HardRuleResult[];
      readonly matched: boolean;
      /** OFAC SDN older than 24h (or absent). */
      readonly sdnStale: boolean;
    }
  | {
      readonly stage: "signals";
      readonly tierContribution: RiskTier;
      readonly ceiling?: bigint;
      readonly evidence: readonly SignalResult[];
    }
  | {
      readonly stage: "judgment";
      readonly tierContribution: RiskTier;
      readonly ceiling?: bigint;
      readonly evidence: readonly JudgmentEvidence[];
      /** True when a Hard Rule matched and the judgment input was not consulted. */
      readonly skipped: boolean;
    };

export type HardRuleStageOutcome = Extract<StageOutcome, { stage: "hard-rules" }>;
export type SignalStageOutcome = Extract<StageOutcome, { stage: "signals" }>;
export type JudgmentStageOutcome = Extract<StageOutcome, { stage: "judgment" }>;

/**
 * AD-2a truth-table rows as amended 2026-09-26 (first match wins): 1, 2, 3e, 3, 3a–3d, 4, 5, 6, 7,
 * plus the AD-3 chain fallback.
 */
export type DecisiveRule =
  | "hard-rule" // 1
  | "severe-tier" // 2
  | "human-block" // 3e (checked before row 3)
  | "high-tier" // 3
  | "low-confidence" // 3
  | "chain-unavailable" // AD-3
  | "sanctions-list-stale" // 3a
  | "new-payee-cap" // 3b
  | "contract-payee" // 3c
  | "awaiting-review" // 3d
  | "within-limit" // 4
  | "partial" // 5
  | "budget-used" // 6
  | "zero-target"; // 7: zero Target Limit from a Policy/stage ceiling or a pin at 0 → "a zero Limit holds the payment"

export type OutboxIntent =
  | { readonly kind: "register"; readonly target: bigint }
  | { readonly kind: "tighten"; readonly target: bigint; readonly humanEpoch: bigint }
  | { readonly kind: "pin"; readonly target: 0n };

export interface Evaluation {
  readonly decision: Decision;
  readonly riskTier: RiskTier;
  /** Integer basis points; 10000 when rules/signals alone decided. */
  readonly confidenceBps: number;
  readonly targetLimit: bigint;
  readonly remaining: bigint;
  /** Present iff `decision` is `cap`. */
  readonly payable?: bigint;
  readonly decisiveRule: DecisiveRule;
  readonly reason: string;
  readonly pinRequested: boolean;
  readonly outboxIntent?: OutboxIntent;
  readonly hardRules: readonly HardRuleResult[];
  readonly signals: readonly SignalResult[];
  readonly stages: readonly [HardRuleStageOutcome, SignalStageOutcome, JudgmentStageOutcome];
}
