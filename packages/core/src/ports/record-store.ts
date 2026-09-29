// Record store port (AD-9, AD-25). Append-only, hash-chained per Scope (DecisionRecords and ExternalRecords). The pipeline (Story 2.9)
// finishes every Judge call and chain read first, then calls `append` with a synchronous `build` closure;
// the store holds the Scope head lock only around build + insert.
import type { Hex, Scope, ScopeRecord } from "@horos/schema";

/** Thrown by `append` when `(scope, nonce)` was already used. The whole append is rolled back. */
export class NonceReplayError extends Error {
  override readonly name = "NonceReplayError";
  constructor(
    readonly scope: string,
    readonly nonce: string,
  ) {
    super(`nonce already used in scope ${scope}`);
  }
}

/**
 * Builds the record at `(seq, prevHash)`. Must be synchronous and pure: it runs under the Scope head
 * lock, so its return type is a record, never a Promise.
 */
export type RecordBuilder = (seq: number, prevHash: Hex) => ScopeRecord;

/**
 * Extra writes committed in the same transaction as the record (Story 2.6's outbox upsert). `tx` is the
 * adapter's transaction handle; its type is opaque to core. `recordHash` is the record's canonical hash.
 */
export type ExtraWrites<Tx> = (tx: Tx, record: ScopeRecord, recordHash: Hex) => Promise<void>;

export interface AppendRequest<Tx = unknown> {
  readonly scope: Scope;
  readonly build: RecordBuilder;
  /** Check nonce (bytes32 hex) consumed atomically with the record. */
  readonly nonce?: string;
  readonly extraWrites?: ExtraWrites<Tx>;
}

export interface AppendedRecord {
  readonly record: ScopeRecord;
  readonly recordHash: Hex;
}

export interface RecordStore<Tx = unknown> {
  /** Append one record atomically. Throws `NonceReplayError` on a used nonce; any failure writes nothing. */
  append(req: AppendRequest<Tx>): Promise<AppendedRecord>;
}
