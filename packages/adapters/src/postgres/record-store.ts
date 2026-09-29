// Postgres record store (AD-9, AD-25): DecisionRecords and ExternalRecords (the ScopeRecord union), append-only
// and hash-chained per Scope: no code path
// updates or deletes a record or a nonce. The Scope head row is locked `FOR UPDATE` only around the
// synchronous build and the inserts; Judge calls and chain reads happen before `append` is called.
import { NonceReplayError, scopeKind, type AppendRequest, type AppendedRecord, type RecordStore } from "@horos/core";
import { Address, Bytes32, recordHash, Scope, ScopeRecord, ZERO_BYTES32, type Hex } from "@horos/schema";
import { asc, eq, sql } from "drizzle-orm";
import type { HorosDb } from "./db.js";
import { pgErrorCode, pgErrorConstraint } from "./policy-version-store.js";
import { decisionRecord, recordChainHead, scope as scopeTable, usedNonce } from "./schema.js";

/** The drizzle transaction handle `extraWrites` receives. */
export type HorosTx = Parameters<Parameters<HorosDb["transaction"]>[0]>[0];

const UNIQUE_VIOLATION = "23505";
const NONCE_PK = "used_nonce_pkey";

export interface ScopeRow {
  readonly id: Scope;
  /** Required for `shadow:` and `enforced:` Scopes' owning Customer where known. */
  readonly customerId?: string;
  /** The PolicyWallet address of an `enforced:` Scope. */
  readonly policyWallet?: string;
}

export interface StoredRecord {
  readonly id: string;
  readonly seq: number;
  readonly prevHash: Hex;
  readonly recordHash: Hex;
  readonly record: ScopeRecord;
}

/** A Scope row that disagrees with what the caller or a built record claims about it. */
export class ScopeMismatchError extends Error {
  override readonly name = "ScopeMismatchError";
  constructor(
    readonly scope: string,
    detail: string,
  ) {
    super(`scope ${scope} ${detail}`);
  }
}

async function loadScope(
  conn: HorosDb | HorosTx,
  id: string,
): Promise<{ readonly kind: string; readonly customerId: string | null; readonly policyWallet: string | null } | undefined> {
  const rows = await conn
    .select({ kind: scopeTable.kind, customerId: scopeTable.customerId, policyWallet: scopeTable.policyWallet })
    .from(scopeTable)
    .where(eq(scopeTable.id, id));
  return rows[0];
}

export class PostgresRecordStore implements RecordStore<HorosTx> {
  constructor(private readonly db: HorosDb) {}

  /**
   * Create the Scope row if it does not exist yet (insert-only; an existing row is never changed). Throws
   * `ScopeMismatchError` when the id already exists with a different kind, Customer or PolicyWallet. Pass `conn`
   * to run inside a caller's transaction.
   */
  async ensureScope(row: ScopeRow, conn: HorosDb | HorosTx = this.db): Promise<void> {
    const id = Scope.parse(row.id);
    const want = {
      kind: scopeKind(id),
      customerId: row.customerId ?? null,
      policyWallet: row.policyWallet === undefined ? null : Address.parse(row.policyWallet),
    };
    await conn.insert(scopeTable).values({ id, ...want }).onConflictDoNothing({ target: scopeTable.id });
    const stored = await loadScope(conn, id);
    if (
      stored === undefined ||
      stored.kind !== want.kind ||
      stored.customerId !== want.customerId ||
      stored.policyWallet !== want.policyWallet
    ) {
      throw new ScopeMismatchError(id, "already exists with a different kind, customerId or policyWallet");
    }
  }

  /**
   * Append one record to `scope`'s chain in a single transaction: ensure head → lock head → build →
   * validate + hash + insert → nonce → extraWrites → advance head. Any failure writes nothing.
   * The Scope must exist (`ensureScope`); a record whose customerId/policyWallet disagree with it throws
   * `ScopeMismatchError`. Throws `NonceReplayError` on a used `(scope, nonce)`.
   */
  async append(req: AppendRequest<HorosTx>): Promise<AppendedRecord> {
    const scope = Scope.parse(req.scope);
    const nonce = req.nonce === undefined ? undefined : Bytes32.parse(req.nonce);
    return this.db.transaction(async (tx) => {
      // Scope rows are insert-only, so reading the owner before taking the head lock is safe.
      const owner = await loadScope(tx, scope);
      if (owner === undefined) throw new ScopeMismatchError(scope, "does not exist; call ensureScope first");
      await tx
        .insert(recordChainHead)
        .values({ scope, nextSeq: 0, headHash: ZERO_BYTES32 })
        .onConflictDoNothing({ target: recordChainHead.scope });
      const heads = await tx
        .select({ nextSeq: recordChainHead.nextSeq, headHash: recordChainHead.headHash })
        .from(recordChainHead)
        .where(eq(recordChainHead.scope, scope))
        .for("update");
      const head = heads[0];
      if (head === undefined) throw new Error(`record_chain_head missing for scope ${scope}`);
      const prevHash = Bytes32.parse(head.headHash);

      // Synchronous by type: no awaits while the head lock is held other than the inserts below.
      const record = ScopeRecord.parse(req.build(head.nextSeq, prevHash));
      if (record.scope !== scope || record.seq !== head.nextSeq || record.prevHash !== prevHash) {
        throw new Error(`built record does not extend the ${scope} chain at seq ${head.nextSeq}`);
      }
      const hash = recordHash(record);
      // Both record types: an ExternalRecord always names the PolicyWallet, and it must be this Scope's.
      if (owner.kind === "enforced" && record.policyWallet !== owner.policyWallet) {
        throw new ScopeMismatchError(scope, "record policyWallet differs from the Scope's PolicyWallet");
      }
      if (owner.customerId !== null && record.customerId !== owner.customerId) {
        throw new ScopeMismatchError(scope, "record customerId differs from the Scope's Customer");
      }

      await tx.insert(decisionRecord).values({
        id: record.id,
        scope,
        seq: record.seq,
        prevHash,
        recordHash: hash,
        record,
        createdAt: new Date(record.createdAt),
      });
      if (nonce !== undefined) {
        try {
          await tx.insert(usedNonce).values({ scope, nonce, recordId: record.id });
        } catch (err) {
          if (pgErrorCode(err) === UNIQUE_VIOLATION && pgErrorConstraint(err) === NONCE_PK) {
            throw new NonceReplayError(scope, nonce);
          }
          throw err;
        }
      }
      if (req.extraWrites !== undefined) await req.extraWrites(tx, record, hash);
      await tx
        .update(recordChainHead)
        .set({ nextSeq: sql`${recordChainHead.nextSeq} + 1`, headHash: hash })
        .where(eq(recordChainHead.scope, scope));
      return { record, recordHash: hash };
    });
  }

  /** The chain head of `scope`, or `undefined` before its first append. */
  async head(scope: Scope): Promise<{ readonly nextSeq: number; readonly headHash: Hex } | undefined> {
    const rows = await this.db
      .select({ nextSeq: recordChainHead.nextSeq, headHash: recordChainHead.headHash })
      .from(recordChainHead)
      .where(eq(recordChainHead.scope, Scope.parse(scope)));
    const row = rows[0];
    return row === undefined ? undefined : { nextSeq: row.nextSeq, headHash: Bytes32.parse(row.headHash) };
  }

  /** Every record of `scope`, ordered by seq, as stored (the record is re-parsed, never trusted blindly). */
  async readChain(scope: Scope): Promise<StoredRecord[]> {
    return readChain(this.db, scope);
  }
}

async function readChain(db: HorosDb, scope: Scope): Promise<StoredRecord[]> {
  const rows = await db
    .select()
    .from(decisionRecord)
    .where(eq(decisionRecord.scope, Scope.parse(scope)))
    .orderBy(asc(decisionRecord.seq));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    prevHash: Bytes32.parse(r.prevHash),
    recordHash: Bytes32.parse(r.recordHash),
    record: ScopeRecord.parse(r.record),
  }));
}

/**
 * Export `scope`'s chain as JSON Lines of `{recordHash, record}` ordered by seq (one object per line, each
 * line newline-terminated). The stored hash is exported as-is so `@horos/verify` can recompute it.
 */
export async function exportScopeChain(db: HorosDb, scope: Scope): Promise<string> {
  const rows = await db
    .select({ recordHash: decisionRecord.recordHash, record: decisionRecord.record })
    .from(decisionRecord)
    .where(eq(decisionRecord.scope, Scope.parse(scope)))
    .orderBy(asc(decisionRecord.seq));
  return rows.map((r) => `${JSON.stringify({ recordHash: r.recordHash, record: r.record })}\n`).join("");
}
