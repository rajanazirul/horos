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
  RecordStore,
} from "@horos/core";
import type { CheckMessage, Hex, HorosDomain, LimitWrite, PolicyVersion } from "@horos/schema";

/** The mirrored on-chain state the stale fallback uses (AD-3, AD-24). */
export type MirrorView = Pick<ChainView, "limit" | "pinned" | "registered" | "humanSet" | "humanEpoch">;

/** Who a Check is attributed to, for rate limiting (`admit`). */
export type CheckPrincipal = { readonly kind: "customer"; readonly customerId: string } | { readonly kind: "advisory" };

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
  /** How long to wait for the limit write to confirm. Default 2000 ms; 0 reads the state once. */
  readonly limitWriteWaitMs?: number;
  /** Structured log sink. Entries never carry Declared Identity or signatures. */
  readonly log?: (entry: Record<string, unknown>) => void;
}
