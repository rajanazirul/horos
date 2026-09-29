// Postgres ReadStore (Story 2.8, AD-19, AD-25): read-only queries behind the Decision Record API and the
// Counterparty status projection. Nothing here writes; every row is re-parsed, never trusted blindly.
import {
  scopeKind,
  statusEntries,
  type CounterpartyStatusInputs,
  type ReadMirror,
  type ReadPage,
  type ReadReceipt,
  type ReadReceiptStatus,
  type ReadRecord,
  type ReadScopeInfo,
  type ReadStore,
  type StatusInputs,
} from "@horos/core";
import { Address, Bytes32, READ_PAGE_DEFAULT, READ_PAGE_MAX, Scope, ScopeRecord, UuidV7, type Hex } from "@horos/schema";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { HorosDb } from "./db.js";
import { counterpartyMirror, decisionRecord, outboxIntent, scope as scopeTable, writeReceipt } from "./schema.js";

const RECEIPT_STATUSES: readonly ReadReceiptStatus[] = ["confirmed", "noop", "superseded_by_human", "failed_terminal"];

/** `limit` in 1..READ_PAGE_MAX (default READ_PAGE_DEFAULT); anything else throws RangeError. */
export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return READ_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_PAGE_MAX) throw new RangeError(`limit must be an integer in 1..${READ_PAGE_MAX}`);
  return limit;
}

const counterpartyOf = sql`(${decisionRecord.record}->>'counterparty')`;

function toReadRecord(r: { seq: number; recordHash: string; record: unknown }): ReadRecord {
  return { seq: r.seq, recordHash: Bytes32.parse(r.recordHash), record: ScopeRecord.parse(r.record) };
}

function toMirror(r: { registered: boolean; limit: string; pinned: boolean }): ReadMirror {
  return { registered: r.registered, limit: BigInt(r.limit), pinned: r.pinned };
}

export class PostgresReadStore implements ReadStore {
  constructor(private readonly db: HorosDb) {}

  async scopeInfo(scope: Scope): Promise<ReadScopeInfo | undefined> {
    const rows = await this.db
      .select({ id: scopeTable.id, policyWallet: scopeTable.policyWallet })
      .from(scopeTable)
      .where(eq(scopeTable.id, Scope.parse(scope)));
    const row = rows[0];
    if (row === undefined) return undefined;
    const kind = scopeKind(row.id);
    return row.policyWallet === null ? { kind } : { kind, policyWallet: Address.parse(row.policyWallet) };
  }

  async listRecords(scope: Scope, opts: { readonly afterSeq?: number; readonly limit?: number } = {}): Promise<ReadPage<ReadRecord, number>> {
    const limit = pageLimit(opts.limit);
    const s = Scope.parse(scope);
    const where = opts.afterSeq === undefined ? eq(decisionRecord.scope, s) : and(eq(decisionRecord.scope, s), gt(decisionRecord.seq, opts.afterSeq));
    const rows = await this.db
      .select({ seq: decisionRecord.seq, recordHash: decisionRecord.recordHash, record: decisionRecord.record })
      .from(decisionRecord)
      .where(where)
      .orderBy(asc(decisionRecord.seq))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toReadRecord);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last !== undefined ? last.seq : null };
  }

  async recordDetail(scope: Scope, id: string): Promise<{ readonly record: ReadRecord; readonly receipts: readonly ReadReceipt[] } | undefined> {
    const parsedId = UuidV7.safeParse(id);
    if (!parsedId.success) return undefined;
    const s = Scope.parse(scope);
    const rows = await this.db
      .select({ seq: decisionRecord.seq, recordHash: decisionRecord.recordHash, record: decisionRecord.record })
      .from(decisionRecord)
      .where(and(eq(decisionRecord.scope, s), eq(decisionRecord.id, parsedId.data)));
    const row = rows[0];
    if (row === undefined) return undefined;
    const receipts = await this.db
      .select({
        id: writeReceipt.id,
        recordId: writeReceipt.recordId,
        outboxIntentId: writeReceipt.outboxIntentId,
        status: writeReceipt.status,
        pin: outboxIntent.pin,
        txHash: writeReceipt.txHash,
        onchainLimitAfter: writeReceipt.onchainLimitAfter,
        blockNumber: writeReceipt.blockNumber,
        createdAt: writeReceipt.createdAt,
      })
      .from(writeReceipt)
      .innerJoin(outboxIntent, eq(outboxIntent.id, writeReceipt.outboxIntentId))
      .where(and(eq(writeReceipt.scope, s), eq(writeReceipt.recordId, parsedId.data)))
      .orderBy(asc(writeReceipt.createdAt), asc(writeReceipt.id));
    return {
      record: toReadRecord(row),
      receipts: receipts.map((r) => {
        const status = r.status as ReadReceiptStatus;
        if (!RECEIPT_STATUSES.includes(status)) throw new TypeError("bad write_receipt.status");
        return {
          id: r.id,
          recordId: r.recordId,
          outboxIntentId: r.outboxIntentId,
          status,
          pin: r.pin,
          txHash: r.txHash === null ? null : Bytes32.parse(r.txHash),
          onchainLimitAfter: r.onchainLimitAfter === null ? null : BigInt(r.onchainLimitAfter),
          blockNumber: r.blockNumber,
          createdAt: r.createdAt,
        };
      }),
    };
  }

  async statusInputs(scope: Scope, counterparty: Hex): Promise<StatusInputs> {
    const a = Address.parse(counterparty);
    const page = await this.inputsFor(Scope.parse(scope), [a]);
    return page.get(a) ?? { entries: [] };
  }

  async listCounterparties(scope: Scope, opts: { readonly after?: Hex; readonly limit?: number } = {}): Promise<ReadPage<CounterpartyStatusInputs, Hex>> {
    const limit = pageLimit(opts.limit);
    const s = Scope.parse(scope);
    const after = opts.after === undefined ? null : Address.parse(opts.after);
    const res = await this.db.execute(sql`
      SELECT address FROM (
        SELECT ${counterpartyMirror.address} AS address FROM ${counterpartyMirror} WHERE ${counterpartyMirror.scope} = ${s}
        UNION
        SELECT ${counterpartyOf} AS address FROM ${decisionRecord}
          WHERE ${decisionRecord.scope} = ${s} AND ${counterpartyOf} IS NOT NULL
      ) u
      WHERE ${after}::text IS NULL OR address > ${after}::text
      ORDER BY address
      LIMIT ${limit + 1}`);
    const rows = (res as unknown as { rows: { address: string }[] }).rows;
    const addresses = rows.slice(0, limit).map((r) => Address.parse(r.address));
    const inputs = await this.inputsFor(s, addresses);
    const items = addresses.map((address) => ({ address, ...(inputs.get(address) ?? { entries: [] }) }));
    const last = addresses[addresses.length - 1];
    return { items, nextCursor: rows.length > limit && last !== undefined ? last : null };
  }

  /** Fold inputs for each of `addresses` (records, confirmed receipts, mirror row), in three queries. */
  private async inputsFor(scope: Scope, addresses: readonly Hex[]): Promise<Map<Hex, StatusInputs>> {
    const out = new Map<Hex, StatusInputs>();
    if (addresses.length === 0) return out;
    const list = [...addresses];
    const records = await this.db
      .select({ seq: decisionRecord.seq, record: decisionRecord.record, counterparty: sql<string>`${counterpartyOf}` })
      .from(decisionRecord)
      .where(and(eq(decisionRecord.scope, scope), inArray(counterpartyOf, list)))
      .orderBy(asc(decisionRecord.seq));
    const receipts = await this.db
      .select({ seq: decisionRecord.seq, pin: outboxIntent.pin, counterparty: outboxIntent.counterparty })
      .from(writeReceipt)
      .innerJoin(decisionRecord, eq(decisionRecord.id, writeReceipt.recordId))
      .innerJoin(outboxIntent, eq(outboxIntent.id, writeReceipt.outboxIntentId))
      .where(and(eq(writeReceipt.scope, scope), eq(writeReceipt.status, "confirmed"), inArray(outboxIntent.counterparty, list)));
    const mirrors = await this.db
      .select({ address: counterpartyMirror.address, registered: counterpartyMirror.registered, limit: counterpartyMirror.limit, pinned: counterpartyMirror.pinned })
      .from(counterpartyMirror)
      .where(and(eq(counterpartyMirror.scope, scope), inArray(counterpartyMirror.address, list)));
    for (const a of addresses) {
      const recs = records.filter((r) => r.counterparty === a).map((r) => ({ seq: r.seq, record: ScopeRecord.parse(r.record) }));
      const rcpts = receipts.filter((r) => r.counterparty === a).map((r) => ({ seq: r.seq, pin: r.pin }));
      const m = mirrors.find((r) => r.address === a);
      out.set(a, { entries: statusEntries(recs, rcpts), ...(m === undefined ? {} : { mirror: toMirror(m) }) });
    }
    return out;
  }
}
