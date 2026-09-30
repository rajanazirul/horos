// Ports one Check runs through (Story 2.9, AD-1, AD-22). The api wires Postgres/viem adapters behind them;
// the pipeline imports only core and schema.
import type {
  Binding,
  ChainReader,
  ChainView,
  Evaluation,
  ExtraWrites,
  IdentityBinding,
  ListSnapshot,
  OutboxIntent,
  RecordStore,
} from "@horos/core";
import type { CheckMessage, Hex, HorosDomain, LimitWrite, PolicyVersion } from "@horos/schema";

/** The mirrored on-chain state the stale fallback uses (AD-3, AD-24). */
export type MirrorView = Pick<ChainView, "limit" | "pinned" | "registered" | "humanSet" | "humanEpoch">;

/** Who a Check is attributed to, for rate limiting (`admit`). A shadow Check counts against its Customer's shadow key. */
export type CheckPrincipal =
  | { readonly kind: "customer"; readonly customerId: string }
  | { readonly kind: "shadow"; readonly customerId: string }
  | { readonly kind: "advisory" };

/** The virtual effect of one shadow Decision (Story 3.4): the would-be outbox intent and the would-be payment. */
export interface LedgerEffect {
  readonly intent?: OutboxIntent;
  /** `amount` on `allow`, `payable_amount` on `cap`, 0 on `hold` / `block`. */
  readonly spend: bigint;
}

/**
 * The shadow virtual ledger (Story 3.4, AD-7, AD-25): Limits, spend and new-payee counts a shadow Scope's Decisions
 * would have produced on-chain, computed by the adapters' port of the contract's rolling window. Shadow Scopes only.
 */
/** The on-chain Policy values the virtual ledger's windows use (from the Scope's active PolicyVersion's Preset). */
export interface LedgerWindowPolicy {
  readonly firstContactCeiling: bigint;
  readonly walletPeriodCap: bigint;
  readonly newPayeeCap: bigint;
  readonly policyPeriodDays: bigint;
}

export interface VirtualLedger<Tx = unknown> {
  /** The virtual `remaining(a)` of `scope` at `now` under `policy`. */
  remaining(scope: string, counterparty: Hex, now: Date, policy: LedgerWindowPolicy): Promise<ChainView>;
  /** Virtual history: `a` has a virtual Registration in `scope`. */
  hasHistory(scope: string, counterparty: Hex): Promise<boolean>;
  /**
   * The ledger writes for one Decision, committed in its record-append transaction. Throws core's
   * `ShadowClosedError` (rolling the append back) when the Customer's binding became `bound`.
   */
  apply(scope: string, counterparty: Hex, effect: LedgerEffect, now: Date, policy: LedgerWindowPolicy): ExtraWrites<Tx>;
  /** True once the Customer's enforced binding is `bound`: shadow Checks answer `shadow_closed`. */
  isClosed(customerId: string): Promise<boolean>;
}

/** Why a Check ran advisory-public. Never logged with the signature or Declared Identity. */
export type AdvisoryReason = "unsigned" | "expired" | "bad-signature" | "unbound" | "replayed" | "wrong-signer" | "nonce-race";

export interface CheckDeps<Tx = unknown> {
  readonly chainId: number;
  readonly chain: ChainReader;
  readonly records: RecordStore<Tx>;
  /** The lowercase EIP-712 "Horos Check" signer, or undefined when the signature does not recover. */
  readonly recoverCheckSigner: (domain: HorosDomain<"Horos Check">, message: CheckMessage, signature: Hex) => Promise<Hex | undefined>;
  /** The active list snapshots (OFAC SDN, Horos Demo List). */
  readonly lists: () => Promise<readonly ListSnapshot[]>;
  /** The latest PolicyVersion of `scope`. */
  readonly activePolicy: (scope: string) => Promise<PolicyVersion | undefined>;
  /** Insert the exact Standard Preset copy as the first PolicyVersion of `scope` (idempotent). */
  readonly ensurePresetPolicy: (scope: string) => Promise<unknown>;
  /** Create the `advisory-public` Scope row if missing (idempotent). */
  readonly ensureAdvisoryScope: () => Promise<void>;
  readonly mirror: (scope: string, counterparty: Hex) => Promise<MirrorView | undefined>;
  readonly pendingIntentTarget: (scope: string, counterparty: Hex) => Promise<bigint | undefined>;
  readonly hasHistory: (scope: string, counterparty: Hex) => Promise<boolean>;
  /** Bindings in `scope` whose key is one of `keys` (the request's `identityKeys`); never called with none. */
  readonly identityBindings: (scope: string, keys: readonly string[]) => Promise<readonly IdentityBinding[]>;
  readonly nonceUsed: (scope: string, nonce: Hex) => Promise<boolean>;
  readonly bindingByWallet: (policyWallet: Hex) => Promise<Binding | undefined>;
  /** The outbox upsert committed with the record (enforced Checks only). */
  readonly outboxWrites: (evaluation: Evaluation, ctx: { readonly now: Date; readonly humanEpoch: bigint }) => ExtraWrites<Tx>;
  readonly intentState: (scope: string, counterparty: Hex, recordId: string) => Promise<LimitWrite>;
  readonly intentTxHash: (scope: string, counterparty: Hex, recordId: string) => Promise<Hex | undefined>;
  readonly now: () => Date;
  /** A fresh lowercase UUIDv7. */
  readonly newId: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long to wait for the limit write to confirm. Default 0 (read the state once, no wait); non-finite means the default. */
  readonly limitWriteWaitMs?: number;
  /** The shadow virtual ledger; required by `runShadowCheck` only. The enforced path never touches it. */
  readonly ledger?: VirtualLedger<Tx>;
  /** Structured log sink. Entries never carry Declared Identity or signatures. */
  readonly log?: (entry: Record<string, unknown>) => void;
}
