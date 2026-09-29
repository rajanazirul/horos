// Read-only Decision Record and Counterparty status port (Story 2.8, AD-19, AD-25). Nothing here writes.
import type { Hex, Scope, ScopeRecord } from "@horos/schema";
import type { ScopeKind } from "../record/build.js";
import type { StatusEntry } from "../status/fold.js";

export interface ReadScopeInfo {
  readonly kind: ScopeKind;
  /** The PolicyWallet of an enforced Scope. */
  readonly policyWallet?: Hex;
}

export interface ReadRecord {
  readonly seq: number;
  readonly recordHash: Hex;
  readonly record: ScopeRecord;
}

export type ReadReceiptStatus = "confirmed" | "noop" | "superseded_by_human" | "failed_terminal";

export interface ReadReceipt {
  readonly id: string;
  readonly recordId: string;
  readonly outboxIntentId: string;
  readonly status: ReadReceiptStatus;
  /** Whether the receipt's outbox intent was a pin. */
  readonly pin: boolean;
  readonly txHash: Hex | null;
  readonly onchainLimitAfter: bigint | null;
  readonly blockNumber: bigint | null;
  readonly createdAt: Date;
}

/** The indexer mirror's view of one Counterparty. */
export interface ReadMirror {
  readonly registered: boolean;
  readonly limit: bigint;
  readonly pinned: boolean;
}

export interface StatusInputs {
  readonly entries: readonly StatusEntry[];
  readonly mirror?: ReadMirror;
}

export interface CounterpartyStatusInputs extends StatusInputs {
  readonly address: Hex;
}

export interface ReadPage<T, C> {
  readonly items: readonly T[];
  /** Pass as `after` for the next page; null at the end. */
  readonly nextCursor: C | null;
}

export interface ReadStore {
  /** The Scope's kind and PolicyWallet, or undefined when the Scope does not exist. */
  scopeInfo(scope: Scope): Promise<ReadScopeInfo | undefined>;
  /** Records in seq order after `afterSeq`; `limit` 1..READ_PAGE_MAX (default READ_PAGE_DEFAULT, from @horos/schema). */
  listRecords(scope: Scope, opts?: { readonly afterSeq?: number; readonly limit?: number }): Promise<ReadPage<ReadRecord, number>>;
  /** One record and every WriteReceipt of it, or undefined. */
  recordDetail(scope: Scope, id: string): Promise<{ readonly record: ReadRecord; readonly receipts: readonly ReadReceipt[] } | undefined>;
  /** Fold entries (records whose counterparty matches, plus confirmed receipts) and the mirror row. */
  statusInputs(scope: Scope, counterparty: Hex): Promise<StatusInputs>;
  /** Every address in the mirror ∪ every record counterparty, ordered by address, with its fold inputs. */
  listCounterparties(scope: Scope, opts?: { readonly after?: Hex; readonly limit?: number }): Promise<ReadPage<CounterpartyStatusInputs, Hex>>;
}
