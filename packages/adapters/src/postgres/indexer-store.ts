// Postgres store behind the Story 2.7 chain-event indexer (AD-9, AD-24). The worker indexer is the only
// writer of the Counterparty mirror, WriteReceipts, `Paid` history and the indexer cursor; the api writes none
// of them. Every write is idempotent, so re-indexing a chunk after a crash changes nothing.
import type { OutboxIntentRow } from "@horos/core";
import { Address, Bytes32, ExternalRecord, Scope, type Hex } from "@horos/schema";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { uuidv7 } from "../ids.js";
import type { HorosDb } from "./db.js";
import { outboxRowFrom } from "./outbox-store.js";
import type { HorosTx } from "./record-store.js";
import { counterpartyMirror, decisionRecord, enforcedBinding, indexerCursor, outboxIntent, paidEvent, writeReceipt } from "./schema.js";

export type ReceiptStatus = "confirmed" | "noop" | "superseded_by_human" | "failed_terminal";

/** A bound enforced Scope the indexer tails. */
export interface BoundWallet {
  readonly scope: Scope;
  readonly customerId: string;
  readonly policyWallet: Hex;
}

export interface WriteReceiptRow {
  readonly id: string;
  readonly scope: string;
  readonly recordId: string;
  readonly outboxIntentId: string;
  readonly status: ReceiptStatus;
  readonly txHash: Hex | null;
  readonly onchainLimitAfter: bigint | null;
  readonly blockNumber: bigint | null;
  readonly createdAt: Date;
}

/** The mirrored on-chain state of one Counterparty, and the chain position it reflects. */
export interface MirrorState {
  readonly registered: boolean;
  readonly limit: bigint;
  readonly pinned: boolean;
  readonly humanSet: boolean;
  readonly humanEpoch: bigint;
  /** Unix seconds of the pending Human unpin request; null when none. */
  readonly unpinRequestedAt: bigint | null;
  readonly firstRegisteredBlock: bigint | null;
  readonly lastBlock: bigint;
  readonly lastLogIndex: number;
}

/** One Counterparty event, reduced to what the mirror needs. */
export type MirrorEvent =
  | { readonly kind: "registered"; readonly limit: bigint }
  | { readonly kind: "tightened"; readonly limit: bigint }
  | { readonly kind: "pinned" }
  /** `humanEpochBump`: a Human `executeUnpin` also bumps the epoch; a Rules `releasePin` does not. */
  | { readonly kind: "pin-released"; readonly humanEpochBump: boolean }
  | { readonly kind: "limit-set"; readonly limit: bigint; readonly humanEpoch: bigint }
  | { readonly kind: "unpin-requested"; readonly at: bigint };

export interface ChainPosition {
  readonly block: bigint;
  readonly logIndex: number;
}

const EMPTY: Omit<MirrorState, "lastBlock" | "lastLogIndex"> = {
  registered: false,
  limit: 0n,
  pinned: false,
  humanSet: false,
  humanEpoch: 0n,
  unpinRequestedAt: null,
  firstRegisteredBlock: null,
};

const later = (p: ChainPosition, s: MirrorState): boolean => p.block > s.lastBlock || (p.block === s.lastBlock && p.logIndex > s.lastLogIndex);

/**
 * Apply `event` at `pos` to `state` (undefined: no row yet). Pure. An event at or before the stored position
 * changes nothing, except that a registration may move `firstRegisteredBlock` earlier.
 */
export function foldMirror(state: MirrorState | undefined, event: MirrorEvent, pos: ChainPosition): MirrorState {
  if (state !== undefined && !later(pos, state)) {
    if (event.kind === "registered" && (state.firstRegisteredBlock === null || pos.block < state.firstRegisteredBlock)) {
      return { ...state, firstRegisteredBlock: pos.block };
    }
    return state;
  }
  const s: MirrorState = { ...(state ?? EMPTY), lastBlock: pos.block, lastLogIndex: pos.logIndex };
  switch (event.kind) {
    case "registered":
      return {
        ...s,
        registered: true,
        limit: event.limit,
        firstRegisteredBlock: s.firstRegisteredBlock === null || pos.block < s.firstRegisteredBlock ? pos.block : s.firstRegisteredBlock,
      };
    case "tightened":
      return { ...s, limit: event.limit };
    case "pinned":
      return { ...s, pinned: true, limit: 0n, registered: true, unpinRequestedAt: null };
    case "pin-released":
      return { ...s, pinned: false, unpinRequestedAt: null, humanEpoch: event.humanEpochBump ? s.humanEpoch + 1n : s.humanEpoch };
    case "limit-set":
      return { ...s, limit: event.limit, humanSet: true, humanEpoch: event.humanEpoch, registered: true };
    case "unpin-requested":
      return { ...s, unpinRequestedAt: event.at };
  }
}

function sameMirror(a: MirrorState, b: MirrorState): boolean {
  return (
    a.registered === b.registered &&
    a.limit === b.limit &&
    a.pinned === b.pinned &&
    a.humanSet === b.humanSet &&
    a.humanEpoch === b.humanEpoch &&
    a.unpinRequestedAt === b.unpinRequestedAt &&
    a.firstRegisteredBlock === b.firstRegisteredBlock &&
    a.lastBlock === b.lastBlock &&
    a.lastLogIndex === b.lastLogIndex
  );
}

function mirrorFrom(r: typeof counterpartyMirror.$inferSelect): MirrorState {
  return {
    registered: r.registered,
    limit: BigInt(r.limit),
    pinned: r.pinned,
    humanSet: r.humanSet,
    humanEpoch: BigInt(r.humanEpoch),
    unpinRequestedAt: r.unpinRequestedAt === null ? null : BigInt(r.unpinRequestedAt),
    firstRegisteredBlock: r.firstRegisteredBlock,
    lastBlock: r.lastBlock,
    lastLogIndex: r.lastLogIndex,
  };
}

function mirrorColumns(s: MirrorState) {
  return {
    registered: s.registered,
    limit: s.limit.toString(),
    pinned: s.pinned,
    humanSet: s.humanSet,
    humanEpoch: s.humanEpoch.toString(),
    unpinRequestedAt: s.unpinRequestedAt === null ? null : s.unpinRequestedAt.toString(),
    firstRegisteredBlock: s.firstRegisteredBlock,
    lastBlock: s.lastBlock,
    lastLogIndex: s.lastLogIndex,
  };
}

const RECEIPT_STATUSES: readonly ReceiptStatus[] = ["confirmed", "noop", "superseded_by_human", "failed_terminal"];

function receiptFrom(r: typeof writeReceipt.$inferSelect): WriteReceiptRow {
  const status = r.status as ReceiptStatus;
  if (!RECEIPT_STATUSES.includes(status)) throw new TypeError("bad write_receipt.status");
  return {
    id: r.id,
    scope: r.scope,
    recordId: r.recordId,
    outboxIntentId: r.outboxIntentId,
    status,
    txHash: r.txHash === null ? null : Bytes32.parse(r.txHash),
    onchainLimitAfter: r.onchainLimitAfter === null ? null : BigInt(r.onchainLimitAfter),
    blockNumber: r.blockNumber,
    createdAt: r.createdAt,
  };
}

export interface ConfirmIntent {
  readonly intentId: string;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly onchainLimitAfter: bigint;
  readonly now: Date;
}

export interface IntentMatch {
  /** The intent to confirm (the surviving one, after following `merged_into`). */
  readonly intent: OutboxIntentRow;
  /** The row whose `send_record_hash` the mined call carried (compatibility is checked against it). */
  readonly sentBy: OutboxIntentRow;
}

export interface PaidEventInput {
  readonly scope: string;
  readonly policyWallet: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly counterparty: Hex;
  readonly amount: bigint;
  readonly recordHash: Hex;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
}

export interface PaidEventRow extends PaidEventInput {
  readonly matchedRecordId: string | null;
}

export class PostgresIndexerStore {
  constructor(
    private readonly db: HorosDb,
    private readonly newId: (nowMs: number) => string = uuidv7,
  ) {}

  /** Every bound enforced binding, oldest Customer id first. */
  async boundWallets(): Promise<BoundWallet[]> {
    const rows = await this.db
      .select({ scope: enforcedBinding.scopeId, customerId: enforcedBinding.customerId, policyWallet: enforcedBinding.policyWallet })
      .from(enforcedBinding)
      .where(and(eq(enforcedBinding.status, "bound"), isNotNull(enforcedBinding.policyWallet)))
      .orderBy(asc(enforcedBinding.customerId));
    return rows.map((r) => ({ scope: Scope.parse(r.scope), customerId: r.customerId, policyWallet: Address.parse(r.policyWallet) }));
  }

  /** The next block to index for `policyWallet`, or undefined before the first run. */
  async cursor(policyWallet: Hex): Promise<bigint | undefined> {
    const rows = await this.db
      .select({ nextBlock: indexerCursor.nextBlock })
      .from(indexerCursor)
      .where(eq(indexerCursor.policyWallet, Address.parse(policyWallet)));
    return rows[0]?.nextBlock;
  }

  async setCursor(policyWallet: Hex, scope: string, nextBlock: bigint, now: Date): Promise<void> {
    if (nextBlock < 0n) throw new RangeError("nextBlock must be >= 0");
    await this.db
      .insert(indexerCursor)
      .values({ policyWallet: Address.parse(policyWallet), scope, nextBlock, updatedAt: now })
      .onConflictDoUpdate({ target: indexerCursor.policyWallet, set: { nextBlock, updatedAt: now } });
  }

  /**
   * The intent a Horos write carrying `recordHash` for `(scope, counterparty)` confirms. `sentBy` is the row
   * whose `send_record_hash` matched (the one the mined call was built from); `intent` is the row to confirm:
   * the same row when it is `pending|sending|submitted` (a stored tx hash is only a hint) or already
   * `confirmed` by this very tx (a replay), or, for a `noop` row merged into a newer one, the surviving intent
   * reached through `merged_into`.
   */
  async matchIntent(scope: string, counterparty: Hex, recordHash: Hex, txHash: Hex): Promise<IntentMatch | undefined> {
    const tx = Bytes32.parse(txHash);
    const live = sql`(${outboxIntent.status} IN ('pending', 'sending', 'submitted') OR (${outboxIntent.status} = 'confirmed' AND ${outboxIntent.txHash} = ${tx}))`;
    const rows = await this.db
      .select()
      .from(outboxIntent)
      .where(
        and(
          eq(outboxIntent.scope, scope),
          eq(outboxIntent.counterparty, Address.parse(counterparty)),
          eq(outboxIntent.sendRecordHash, Bytes32.parse(recordHash)),
          sql`(${live} OR (${outboxIntent.status} = 'noop' AND ${outboxIntent.mergedInto} IS NOT NULL))`,
        ),
      )
      .orderBy(sql`${outboxIntent.status} = 'noop'`, asc(outboxIntent.createdAt), asc(outboxIntent.id))
      .limit(1);
    const first = rows[0];
    if (first === undefined) return undefined;
    const sentBy = outboxRowFrom(first);
    const confirmable = (r: typeof first) =>
      r.status === "pending" || r.status === "sending" || r.status === "submitted" || (r.status === "confirmed" && r.txHash === tx);
    let cur = first;
    // Follow merges to the surviving intent (bounded; each merge target is a newer row).
    for (let hop = 0; hop < 32; hop++) {
      if (confirmable(cur)) return { intent: outboxRowFrom(cur), sentBy };
      if (cur.status !== "noop" || cur.mergedInto === null) return undefined;
      const next = (await this.db.select().from(outboxIntent).where(eq(outboxIntent.id, cur.mergedInto)).limit(1))[0];
      if (next === undefined) return undefined;
      cur = next;
    }
    return undefined;
  }

  /**
   * In one transaction: move the intent from `pending|sending|submitted` to `confirmed` with `txHash`
   * (overwriting any stored hint) and write one `confirmed` receipt per contributing record. Returns true when
   * confirmed (or already confirmed by this tx: a replay, nothing written), false when the row is not
   * confirmable (the caller then treats the events as unmatched).
   */
  async confirmIntent(c: ConfirmIntent): Promise<boolean> {
    const txHash = Bytes32.parse(c.txHash);
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select({ status: outboxIntent.status, txHash: outboxIntent.txHash })
        .from(outboxIntent)
        .where(eq(outboxIntent.id, c.intentId))
        .for("update");
      const cur = current[0];
      // Receipts commit with the status change, so an intent already confirmed by this tx is complete.
      if (cur?.status === "confirmed" && cur.txHash === txHash) return true;
      const updated = await tx
        .update(outboxIntent)
        .set({ status: "confirmed", txHash, updatedAt: c.now })
        .where(and(eq(outboxIntent.id, c.intentId), sql`${outboxIntent.status} IN ('pending', 'sending', 'submitted')`))
        .returning({ scope: outboxIntent.scope, recordIds: outboxIntent.recordIds });
      const row = updated[0];
      if (row === undefined) return false;
      await insertReceipts(
        tx,
        row.recordIds.map((recordId) => ({
          id: this.newId(c.now.getTime()),
          scope: row.scope,
          recordId,
          outboxIntentId: c.intentId,
          status: "confirmed" as const,
          txHash,
          onchainLimitAfter: c.onchainLimitAfter.toString(),
          blockNumber: c.blockNumber,
          createdAt: c.now,
        })),
      );
      return true;
    });
  }

  /**
   * `confirmed` receipts for a merged `noop` row's own records only (its surviving intent was not satisfied by
   * the mined write, so it stays unconfirmed and is sent later). Idempotent. False when `rowId` is not a
   * merged `noop` row.
   */
  async confirmMergedRow(c: Omit<ConfirmIntent, "intentId"> & { readonly rowId: string }): Promise<boolean> {
    const txHash = Bytes32.parse(c.txHash);
    const rows = await this.db
      .select({ scope: outboxIntent.scope, recordIds: outboxIntent.recordIds })
      .from(outboxIntent)
      .where(and(eq(outboxIntent.id, c.rowId), eq(outboxIntent.status, "noop"), isNotNull(outboxIntent.mergedInto)));
    const row = rows[0];
    if (row === undefined) return false;
    await insertReceipts(
      this.db,
      row.recordIds.map((recordId) => ({
        id: this.newId(c.now.getTime()),
        scope: row.scope,
        recordId,
        outboxIntentId: c.rowId,
        status: "confirmed" as const,
        txHash,
        onchainLimitAfter: c.onchainLimitAfter.toString(),
        blockNumber: c.blockNumber,
        createdAt: c.now,
      })),
    );
    return true;
  }

  /**
   * Record a `Paid` event (never a chain record). `matched_record_id` is the DecisionRecord of the same Scope
   * whose hash is the payment's `recordHash` and whose Counterparty matches, else null. Idempotent.
   */
  async insertPaid(p: PaidEventInput): Promise<void> {
    const counterparty = Address.parse(p.counterparty);
    const recordHash = Bytes32.parse(p.recordHash);
    const matched = await this.db
      .select({ id: decisionRecord.id })
      .from(decisionRecord)
      .where(
        and(
          eq(decisionRecord.scope, p.scope),
          eq(decisionRecord.recordHash, recordHash),
          sql`${decisionRecord.record}->>'recordType' IS NULL`,
          sql`${decisionRecord.record}->>'counterparty' = ${counterparty}`,
        ),
      )
      .limit(1);
    await this.db
      .insert(paidEvent)
      .values({
        policyWallet: Address.parse(p.policyWallet),
        txHash: Bytes32.parse(p.txHash),
        logIndex: p.logIndex,
        scope: p.scope,
        counterparty,
        amount: p.amount.toString(),
        recordHash,
        matchedRecordId: matched[0]?.id ?? null,
        blockNumber: p.blockNumber,
        blockTimestamp: p.blockTimestamp,
      })
      .onConflictDoNothing({ target: [paidEvent.txHash, paidEvent.logIndex] });
  }

  async paidEvents(scope: string): Promise<PaidEventRow[]> {
    const rows = await this.db.select().from(paidEvent).where(eq(paidEvent.scope, scope)).orderBy(asc(paidEvent.blockNumber), asc(paidEvent.logIndex));
    return rows.map((r) => ({
      scope: r.scope,
      policyWallet: Address.parse(r.policyWallet),
      txHash: Bytes32.parse(r.txHash),
      logIndex: r.logIndex,
      counterparty: Address.parse(r.counterparty),
      amount: BigInt(r.amount),
      recordHash: Bytes32.parse(r.recordHash),
      matchedRecordId: r.matchedRecordId,
      blockNumber: r.blockNumber,
      blockTimestamp: r.blockTimestamp,
    }));
  }

  /** Whether `scope` already holds the ExternalRecord of `txHash`. */
  async hasExternalRecord(scope: string, txHash: Hex): Promise<boolean> {
    const rows = await this.db
      .select({ id: decisionRecord.id })
      .from(decisionRecord)
      .where(
        and(
          eq(decisionRecord.scope, scope),
          sql`${decisionRecord.record}->>'recordType' = 'external'`,
          sql`${decisionRecord.record}->>'txHash' = ${Bytes32.parse(txHash)}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The ExternalRecord of `txHash` in any Scope (a tx calls one PolicyWallet, so at most one), if any. */
  async externalRecordByTx(txHash: Hex): Promise<ExternalRecord | undefined> {
    const rows = await this.db
      .select({ record: decisionRecord.record })
      .from(decisionRecord)
      .where(and(sql`${decisionRecord.record}->>'recordType' = 'external'`, sql`${decisionRecord.record}->>'txHash' = ${Bytes32.parse(txHash)}`))
      .limit(1);
    return rows[0] === undefined ? undefined : ExternalRecord.parse(rows[0].record);
  }

  /** Apply one Counterparty event to the mirror (see `foldMirror`). Returns the resulting state. */
  async applyMirror(scope: string, address: Hex, event: MirrorEvent, pos: ChainPosition, now: Date): Promise<MirrorState> {
    const a = Address.parse(address);
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(counterpartyMirror)
        .where(and(eq(counterpartyMirror.scope, scope), eq(counterpartyMirror.address, a)))
        .for("update");
      const before = rows[0] === undefined ? undefined : mirrorFrom(rows[0]);
      const after = foldMirror(before, event, pos);
      if (before === undefined) {
        await tx.insert(counterpartyMirror).values({ scope, address: a, ...mirrorColumns(after), updatedAt: now });
      } else if (!sameMirror(before, after)) {
        await tx
          .update(counterpartyMirror)
          .set({ ...mirrorColumns(after), updatedAt: now })
          .where(and(eq(counterpartyMirror.scope, scope), eq(counterpartyMirror.address, a)));
      }
      return after;
    });
  }

  async mirror(scope: string, address: Hex): Promise<MirrorState | undefined> {
    const rows = await this.db
      .select()
      .from(counterpartyMirror)
      .where(and(eq(counterpartyMirror.scope, scope), eq(counterpartyMirror.address, Address.parse(address))));
    return rows[0] === undefined ? undefined : mirrorFrom(rows[0]);
  }

  /** The Monitored set: every mirrored address that was ever registered, ordered by address. */
  async monitoredSet(scope: string): Promise<Hex[]> {
    const rows = await this.db
      .select({ address: counterpartyMirror.address })
      .from(counterpartyMirror)
      .where(and(eq(counterpartyMirror.scope, scope), isNotNull(counterpartyMirror.firstRegisteredBlock)))
      .orderBy(asc(counterpartyMirror.address));
    return rows.map((r) => Address.parse(r.address));
  }

  /**
   * Receipts from the outbox's final states, for intents that have none yet: `noop` (not merged) → `noop`;
   * `failed` with `StaleEpoch` → `superseded_by_human`; any other `failed` → `failed_terminal`. One receipt per
   * contributing record. Returns the number of intents reconciled. Idempotent.
   */
  async reconcileReceipts(now: Date): Promise<number> {
    const intents = await this.db
      .select({ id: outboxIntent.id, scope: outboxIntent.scope, recordIds: outboxIntent.recordIds, status: outboxIntent.status, lastError: outboxIntent.lastError })
      .from(outboxIntent)
      .where(
        sql`((${outboxIntent.status} = 'noop' AND ${outboxIntent.mergedInto} IS NULL) OR ${outboxIntent.status} = 'failed')
          AND NOT EXISTS (SELECT 1 FROM write_receipt w WHERE w.outbox_intent_id = ${outboxIntent.id})`,
      )
      .orderBy(asc(outboxIntent.updatedAt), asc(outboxIntent.id));
    for (const i of intents) {
      const status: ReceiptStatus = i.status === "noop" ? "noop" : i.lastError === "StaleEpoch" ? "superseded_by_human" : "failed_terminal";
      await insertReceipts(
        this.db,
        i.recordIds.map((recordId) => ({
          id: this.newId(now.getTime()),
          scope: i.scope,
          recordId,
          outboxIntentId: i.id,
          status,
          txHash: null,
          onchainLimitAfter: null,
          blockNumber: null,
          createdAt: now,
        })),
      );
    }
    return intents.length;
  }

  /** Receipts of `scope` (optionally of one record), oldest first. */
  async receipts(scope: string, recordId?: string): Promise<WriteReceiptRow[]> {
    const where = recordId === undefined ? eq(writeReceipt.scope, scope) : and(eq(writeReceipt.scope, scope), eq(writeReceipt.recordId, recordId));
    const rows = await this.db.select().from(writeReceipt).where(where).orderBy(asc(writeReceipt.createdAt), asc(writeReceipt.id));
    return rows.map(receiptFrom);
  }
}

async function insertReceipts(conn: HorosDb | HorosTx, rows: (typeof writeReceipt.$inferInsert)[]): Promise<void> {
  if (rows.length === 0) return;
  await conn
    .insert(writeReceipt)
    .values(rows)
    .onConflictDoNothing({ target: [writeReceipt.recordId, writeReceipt.outboxIntentId, writeReceipt.status] });
}
