// Outbox port (AD-8, AD-24): one coalesced intent per `(scope, counterparty)` while pending, sent by the
// worker through a ChainWriter. Only the Story 2.7 indexer moves an intent to `confirmed`.
import type { DecisionRecord, Hex, LimitWrite } from "@horos/schema";

export type OutboxLaneRole = "registrar" | "rules";

export type OutboxStatus = "pending" | "sending" | "submitted" | "confirmed" | "noop" | "failed";

export interface OutboxIntentRow {
  readonly id: string;
  readonly scope: string;
  readonly counterparty: Hex;
  readonly laneRole: OutboxLaneRole;
  readonly target: bigint;
  readonly pin: boolean;
  readonly humanEpoch: bigint;
  /** Every record that contributed, in commit order. */
  readonly recordIds: readonly string[];
  readonly createdByRecord: string;
  /** The hash of the record whose Decision the write carries (its `recordHash` argument). */
  readonly sendRecordHash: Hex;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly alerted: boolean;
  readonly circleTxId: string | null;
  readonly txHash: Hex | null;
  readonly lastError: string | null;
  /** Set when a requeue merged this row into a newer pending intent (it then ends as `noop`). */
  readonly mergedInto: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One decision's contribution to the outbox. */
export interface IntentUpsert {
  readonly scope: string;
  readonly counterparty: Hex;
  readonly laneRole: OutboxLaneRole;
  readonly target: bigint;
  readonly pin: boolean;
  readonly humanEpoch: bigint;
  readonly recordId: string;
  readonly recordHash: Hex;
  readonly now: Date;
}

export interface RetryUpdate {
  readonly error: string;
  readonly nextAttemptAt: Date;
  /** Set true once, when the retry alert fires. */
  readonly alerted: boolean;
}

/**
 * The worker's view of the outbox. `Tx` is the adapter's transaction handle: the `*InTx` methods run
 * inside a record append (`RecordStore.append`'s `extraWrites`) so a record and its outbox change commit together.
 */
export interface OutboxStore<Tx = unknown> {
  upsertInTx(tx: Tx, intent: IntentUpsert): Promise<void>;
  /**
   * Claim the oldest due `pending` intent whose lane `(scope, laneRole)` has nothing in flight, skipping
   * locked rows, and move it to `sending`.
   */
  claimNext(now: Date): Promise<OutboxIntentRow | undefined>;
  /** `submitted` intents whose transaction hash is not known yet. */
  listAwaitingTx(): Promise<OutboxIntentRow[]>;
  /** Put `sending` intents untouched since `before` back to `pending` (a crashed send); same attempt count. */
  recoverStale(before: Date, now: Date): Promise<number>;
  markSubmitted(id: string, circleTxId: string, now: Date): Promise<void>;
  markTxHash(id: string, txHash: Hex, now: Date): Promise<void>;
  markNoop(id: string, now: Date): Promise<void>;
  /** sending|submitted → pending with `attempts + 1` and backoff. */
  markRetry(id: string, update: RetryUpdate, now: Date): Promise<void>;
  /** sending|submitted → failed inside a record append; throws when the intent is not in flight. */
  markFailedInTx(tx: Tx, id: string, error: string, now: Date): Promise<void>;
  /** The DecisionRecord whose canonical hash is `hash` (ExternalRecords are never returned). */
  recordByHash(hash: Hex): Promise<DecisionRecord | undefined>;
  intentState(scope: string, counterparty: Hex, recordId: string): Promise<LimitWrite>;
}

/** Backoff after the n-th failed attempt: 30s × 2^(n-1), at most 10 minutes. */
export function outboxBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(30_000 * 2 ** Math.min(n - 1, 20), 10 * 60 * 1000);
}

/** The attempt count at which the one-time `outbox-retry-exhausted` alert fires. */
export const OUTBOX_ALERT_ATTEMPTS = 3;

/**
 * `limit_write` for `recordId` given the intent that contains it (or none): no intent or `noop` → `none`;
 * `confirmed` → `confirmed`; `failed` → `failed`; otherwise `pending` for the creating record and
 * `coalesced` for records merged into it.
 */
export function intentStateOf(row: Pick<OutboxIntentRow, "status" | "recordIds" | "createdByRecord"> | undefined, recordId: string): LimitWrite {
  if (row === undefined || !row.recordIds.includes(recordId) || row.status === "noop") return "none";
  if (row.status === "confirmed") return "confirmed";
  if (row.status === "failed") return "failed";
  return row.createdByRecord === recordId ? "pending" : "coalesced";
}
