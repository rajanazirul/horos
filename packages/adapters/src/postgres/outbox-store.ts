// Postgres coalescing outbox (AD-8, AD-24, Story 2.6). One `pending` intent per `(scope, counterparty)`;
// decisions merge into it inside the record-append transaction (`outboxExtraWrites`). The worker claims
// intents per lane `(scope, lane_role)` and moves them through sending → submitted | noop | failed.
// Only the Story 2.7 indexer sets `confirmed`.
import {
  intentStateOf,
  scopeKind,
  type Evaluation,
  type ExtraWrites,
  type IntentUpsert,
  type OutboxIntentRow,
  type OutboxLaneRole,
  type OutboxStatus,
  type OutboxStore,
  type RetryUpdate,
} from "@horos/core";
import { Address, Bytes32, DecisionRecord, isExternalRecord, type Hex, type LimitWrite } from "@horos/schema";
import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { uuidv7 } from "../ids.js";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { HorosDb } from "./db.js";
import type { HorosTx } from "./record-store.js";
import { decisionRecord, outboxIntent } from "./schema.js";

const MAX_ERROR_LENGTH = 1000;
const STATUSES: readonly OutboxStatus[] = ["pending", "sending", "submitted", "confirmed", "noop", "failed"];

/** Map an `outbox_intent` row to the port type. */
export function outboxRowFrom(r: typeof outboxIntent.$inferSelect): OutboxIntentRow {
  const status = r.status as OutboxStatus;
  if (!STATUSES.includes(status)) throw new TypeError("bad outbox_intent.status");
  if (r.laneRole !== "registrar" && r.laneRole !== "rules") throw new TypeError("bad outbox_intent.lane_role");
  return {
    id: r.id,
    scope: r.scope,
    counterparty: Address.parse(r.counterparty),
    laneRole: r.laneRole,
    target: BigInt(r.target),
    pin: r.pin,
    humanEpoch: BigInt(r.humanEpoch),
    recordIds: [...r.recordIds],
    createdByRecord: r.createdByRecord,
    sendRecordHash: Bytes32.parse(r.sendRecordHash),
    status,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    alerted: r.alerted,
    circleTxId: r.circleTxId,
    txHash: r.txHash === null ? null : Bytes32.parse(r.txHash),
    lastError: r.lastError,
    mergedInto: r.mergedInto,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The lane an intent kind uses: `register` → Registrar; `tighten` / `pin` → Rules (Model is unused until Epic 4). */
export function laneRoleOf(kind: "register" | "tighten" | "pin"): OutboxLaneRole {
  return kind === "register" ? "registrar" : "rules";
}

/**
 * Coalescing upsert (AD-8), run inside the record-append transaction:
 * - `pin = pin OR new.pin`; a pin forces `target 0`;
 * - same epoch: `target = LEAST`; `send_record_hash` moves only when the target strictly drops or pin turns on;
 * - newer epoch: target and epoch replaced (the newer decision saw the Human action), hash moves with it;
 * - older epoch: target and epoch kept;
 * - `record_ids` always appends; the Rules lane dominates the Registrar lane.
 */
export async function upsertIntent(tx: HorosTx | HorosDb, i: IntentUpsert, id: string): Promise<void> {
  const target = i.pin ? 0n : i.target;
  if (target < 0n) throw new RangeError("target must be >= 0");
  if (i.humanEpoch < 0n) throw new RangeError("humanEpoch must be >= 0");
  await tx.execute(sql`
    INSERT INTO outbox_intent AS o (id, scope, counterparty, lane_role, target, pin, human_epoch, record_ids,
      created_by_record, send_record_hash, status, attempts, next_attempt_at, alerted, created_at, updated_at)
    VALUES (${id}::uuid, ${i.scope}, ${Address.parse(i.counterparty)}, ${i.laneRole}, ${target.toString()}::numeric,
      ${i.pin}, ${i.humanEpoch.toString()}::numeric, ARRAY[${i.recordId}::uuid], ${i.recordId}::uuid,
      ${Bytes32.parse(i.recordHash)}, 'pending', 0, ${i.now}, false, ${i.now}, ${i.now})
    ON CONFLICT (scope, counterparty) WHERE status = 'pending' DO UPDATE SET
      pin = o.pin OR EXCLUDED.pin,
      target = CASE
        WHEN o.pin OR EXCLUDED.pin THEN 0
        WHEN EXCLUDED.human_epoch > o.human_epoch THEN EXCLUDED.target
        WHEN EXCLUDED.human_epoch < o.human_epoch THEN o.target
        ELSE LEAST(o.target, EXCLUDED.target) END,
      human_epoch = GREATEST(o.human_epoch, EXCLUDED.human_epoch),
      send_record_hash = CASE
        WHEN o.pin THEN o.send_record_hash
        WHEN EXCLUDED.pin THEN EXCLUDED.send_record_hash
        WHEN EXCLUDED.human_epoch > o.human_epoch THEN EXCLUDED.send_record_hash
        WHEN EXCLUDED.human_epoch = o.human_epoch AND EXCLUDED.target < o.target THEN EXCLUDED.send_record_hash
        ELSE o.send_record_hash END,
      lane_role = CASE WHEN o.lane_role = 'rules' OR EXCLUDED.lane_role = 'rules' THEN 'rules' ELSE o.lane_role END,
      record_ids = o.record_ids || EXCLUDED.record_ids,
      updated_at = EXCLUDED.updated_at
  `);
}

export interface OutboxWriteContext {
  readonly now: Date;
  /** The decision-time Human epoch (the chain view's); used for `register` and `pin` intents. Required. */
  readonly humanEpoch: bigint;
  readonly newId?: (nowMs: number) => string;
}

/**
 * The `extraWrites` that upserts `evaluation.outboxIntent` for the record being appended. Does nothing when
 * the evaluation has no intent or the record's Scope is not `enforced:`.
 */
export function outboxExtraWrites(evaluation: Evaluation, ctx: OutboxWriteContext): ExtraWrites<HorosTx> {
  return async (tx, record, recordHash) => {
    const intent = evaluation.outboxIntent;
    if (intent === undefined || isExternalRecord(record) || scopeKind(record.scope) !== "enforced") return;
    const newId = ctx.newId ?? uuidv7;
    await upsertIntent(
      tx,
      {
        scope: record.scope,
        counterparty: record.counterparty,
        laneRole: laneRoleOf(intent.kind),
        target: intent.target,
        pin: intent.kind === "pin",
        humanEpoch: intent.kind === "tighten" ? intent.humanEpoch : ctx.humanEpoch,
        recordId: record.id,
        recordHash,
        now: ctx.now,
      },
      newId(ctx.now.getTime()),
    );
  };
}

/**
 * An intent waits while its lane `(scope, lane_role)` — or an earlier write for the same Counterparty — is in
 * flight: `sending`, or `submitted` and not yet mined (no tx hash). The Counterparty clause keeps writes for
 * one Counterparty in order across lanes (a tighten never overtakes its registration).
 */
const laneBusy = sql`EXISTS (SELECT 1 FROM outbox_intent b WHERE b.scope = ${outboxIntent.scope}
  AND (b.lane_role = ${outboxIntent.laneRole} OR b.counterparty = ${outboxIntent.counterparty})
  AND (b.status = 'sending' OR (b.status = 'submitted' AND b.tx_hash IS NULL)))`;

export class PostgresOutboxStore implements OutboxStore<HorosTx> {
  constructor(
    private readonly db: HorosDb,
    private readonly newId: (nowMs: number) => string = uuidv7,
  ) {}

  async upsertInTx(tx: HorosTx, intent: IntentUpsert): Promise<void> {
    await upsertIntent(tx, intent, this.newId(intent.now.getTime()));
  }

  async claimNext(now: Date): Promise<OutboxIntentRow | undefined> {
    return this.db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: outboxIntent.id })
        .from(outboxIntent)
        .where(and(eq(outboxIntent.status, "pending"), lte(outboxIntent.nextAttemptAt, now), sql`NOT ${laneBusy}`))
        .orderBy(asc(outboxIntent.createdAt), asc(outboxIntent.id))
        .limit(1)
        .for("update", { skipLocked: true });
      const p = picked[0];
      if (p === undefined) return undefined;
      const updated = await tx
        .update(outboxIntent)
        .set({ status: "sending", updatedAt: now })
        .where(and(eq(outboxIntent.id, p.id), eq(outboxIntent.status, "pending")))
        .returning();
      return updated[0] === undefined ? undefined : outboxRowFrom(updated[0]);
    });
  }

  async listAwaitingTx(): Promise<OutboxIntentRow[]> {
    const rows = await this.db
      .select()
      .from(outboxIntent)
      .where(and(eq(outboxIntent.status, "submitted"), isNull(outboxIntent.txHash)))
      .orderBy(asc(outboxIntent.updatedAt));
    return rows.map(outboxRowFrom);
  }

  async recoverStale(before: Date, now: Date): Promise<number> {
    const stale = await this.db
      .select({ id: outboxIntent.id })
      .from(outboxIntent)
      .where(and(eq(outboxIntent.status, "sending"), lt(outboxIntent.updatedAt, before)));
    let n = 0;
    for (const { id } of stale) {
      if (await this.requeue(id, ["sending"], { lastError: "send interrupted; retrying the same attempt" }, now)) n++;
    }
    return n;
  }

  /**
   * Move an in-flight intent back to `pending`. When a newer `pending` row already exists for the same
   * `(scope, counterparty)` (the partial unique index allows only one), merge this row into it with the
   * coalescing rules of `upsertIntent` and end this row as `noop` with `merged_into` set (so no noop
   * WriteReceipt is written for it: its records live on in the merged intent). One transaction. Returns false when the
   * row was not in `from`.
   */
  private async requeue(id: string, from: readonly OutboxStatus[], set: PgUpdateSetSource<typeof outboxIntent>, now: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const mine = await tx
        .select({ scope: outboxIntent.scope, counterparty: outboxIntent.counterparty })
        .from(outboxIntent)
        .where(and(eq(outboxIntent.id, id), inArray(outboxIntent.status, [...from])))
        .for("update");
      const row = mine[0];
      if (row === undefined) return false;
      const pending = await tx
        .select({ id: outboxIntent.id })
        .from(outboxIntent)
        .where(and(eq(outboxIntent.scope, row.scope), eq(outboxIntent.counterparty, row.counterparty), eq(outboxIntent.status, "pending")))
        .for("update");
      const target = pending[0];
      if (target === undefined) {
        await tx.update(outboxIntent).set({ ...set, status: "pending", updatedAt: now }).where(eq(outboxIntent.id, id));
        return true;
      }
      // Merge this (older, in-flight) row into the pending one: same rules as the upsert, with this row as "new".
      await tx.execute(sql`
        UPDATE outbox_intent AS o SET
          pin = o.pin OR x.pin,
          target = CASE
            WHEN o.pin OR x.pin THEN 0
            WHEN x.human_epoch > o.human_epoch THEN x.target
            WHEN x.human_epoch < o.human_epoch THEN o.target
            ELSE LEAST(o.target, x.target) END,
          human_epoch = GREATEST(o.human_epoch, x.human_epoch),
          send_record_hash = CASE
            WHEN o.pin THEN o.send_record_hash
            WHEN x.pin THEN x.send_record_hash
            WHEN x.human_epoch > o.human_epoch THEN x.send_record_hash
            WHEN x.human_epoch = o.human_epoch AND x.target < o.target THEN x.send_record_hash
            ELSE o.send_record_hash END,
          lane_role = CASE WHEN o.lane_role = 'rules' OR x.lane_role = 'rules' THEN 'rules' ELSE o.lane_role END,
          record_ids = o.record_ids || x.record_ids,
          updated_at = ${now}
        FROM outbox_intent AS x
        WHERE o.id = ${target.id}::uuid AND x.id = ${id}::uuid
      `);
      await tx
        .update(outboxIntent)
        .set({ status: "noop", mergedInto: target.id, lastError: `merged into pending intent ${target.id}`, updatedAt: now })
        .where(eq(outboxIntent.id, id));
      return true;
    });
  }

  private async transition(id: string, from: readonly OutboxStatus[], set: PgUpdateSetSource<typeof outboxIntent>, conn: HorosDb | HorosTx = this.db) {
    const r = await conn
      .update(outboxIntent)
      .set(set)
      .where(and(eq(outboxIntent.id, id), inArray(outboxIntent.status, [...from])))
      .returning({ id: outboxIntent.id });
    if (r.length === 0) throw new Error(`outbox intent ${id} is not in ${from.join("|")}`);
  }

  async markSubmitted(id: string, circleTxId: string, now: Date): Promise<void> {
    await this.transition(id, ["sending"], { status: "submitted", circleTxId, lastError: null, updatedAt: now });
  }

  async markTxHash(id: string, txHash: Hex, now: Date): Promise<void> {
    await this.transition(id, ["submitted"], { txHash: Bytes32.parse(txHash), updatedAt: now });
  }

  async markNoop(id: string, now: Date): Promise<void> {
    await this.transition(id, ["sending"], { status: "noop", updatedAt: now });
  }

  async markRetry(id: string, update: RetryUpdate, now: Date): Promise<void> {
    const ok = await this.requeue(
      id,
      ["sending", "submitted"],
      {
        attempts: sql`${outboxIntent.attempts} + 1`,
        nextAttemptAt: update.nextAttemptAt,
        alerted: update.alerted,
        circleTxId: null,
        lastError: update.error.slice(0, MAX_ERROR_LENGTH),
      },
      now,
    );
    if (!ok) throw new Error(`outbox intent ${id} is not in sending|submitted`);
  }

  async markFailedInTx(tx: HorosTx, id: string, error: string, now: Date): Promise<void> {
    await this.transition(id, ["sending", "submitted"], { status: "failed", lastError: error.slice(0, MAX_ERROR_LENGTH), updatedAt: now }, tx);
  }

  async recordByHash(hash: Hex): Promise<DecisionRecord | undefined> {
    const rows = await this.db
      .select({ record: decisionRecord.record })
      .from(decisionRecord)
      // ExternalRecords are never a write's prior Decision.
      .where(and(eq(decisionRecord.recordHash, Bytes32.parse(hash)), sql`${decisionRecord.record}->>'recordType' IS NULL`))
      .limit(1);
    return rows[0] === undefined ? undefined : DecisionRecord.parse(rows[0].record);
  }

  /** The intent (newest first) of `(scope, counterparty)` that contains `recordId`, if any. */
  async intentOf(scope: string, counterparty: Hex, recordId: string): Promise<OutboxIntentRow | undefined> {
    const rows = await this.db
      .select()
      .from(outboxIntent)
      .where(
        and(
          eq(outboxIntent.scope, scope),
          eq(outboxIntent.counterparty, Address.parse(counterparty)),
          sql`${recordId}::uuid = ANY(${outboxIntent.recordIds})`,
        ),
      )
      // A row merged into a later intent ends as `noop`; the intent it was merged into wins.
      .orderBy(sql`${outboxIntent.status} = 'noop'`, desc(outboxIntent.createdAt))
      .limit(1);
    return rows[0] === undefined ? undefined : outboxRowFrom(rows[0]);
  }

  async intentState(scope: string, counterparty: Hex, recordId: string): Promise<LimitWrite> {
    return intentStateOf(await this.intentOf(scope, counterparty, recordId), recordId);
  }

  async get(id: string): Promise<OutboxIntentRow | undefined> {
    const rows = await this.db.select().from(outboxIntent).where(eq(outboxIntent.id, id)).limit(1);
    return rows[0] === undefined ? undefined : outboxRowFrom(rows[0]);
  }

  /** Every intent of `(scope, counterparty)`, oldest first (tests and diagnostics). */
  async list(scope: string, counterparty?: Hex): Promise<OutboxIntentRow[]> {
    const where =
      counterparty === undefined
        ? eq(outboxIntent.scope, scope)
        : and(eq(outboxIntent.scope, scope), eq(outboxIntent.counterparty, Address.parse(counterparty)));
    const rows = await this.db.select().from(outboxIntent).where(where).orderBy(asc(outboxIntent.createdAt), asc(outboxIntent.id));
    return rows.map(outboxRowFrom);
  }
}
