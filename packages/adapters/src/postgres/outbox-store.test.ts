import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildDecisionRecord,
  evaluate,
  STANDARD_PRESET,
  type ChainView,
  type Evaluation,
  type ListSnapshot,
} from "@horos/core";
import { toWireTime, type Hex, type Scope } from "@horos/schema";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { connectPostgres } from "./connect.js";
import type { HorosDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { outboxExtraWrites, PostgresOutboxStore, upsertIntent } from "./outbox-store.js";
import { PostgresRecordStore } from "./record-store.js";
import { freshDb } from "./test-db.js";

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

const ENFORCED: Scope = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
const SHADOW: Scope = "shadow:01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const CUSTOMER = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const PAYEE: Hex = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const USDC = 1_000_000n;

const lists: ListSnapshot[] = [
  { source: "ofac-sdn", snapshotId: "sdn-1", snapshotHash: `0x${"a".repeat(64)}`, entries: new Map(), lastVerifiedAt: NOW },
];
const firstContact: ChainView = {
  cpRemaining: 0n,
  walletRemaining: 5_000n * USDC,
  newPayeeRemaining: 10n,
  limit: 0n,
  pinned: false,
  registered: false,
  humanSet: false,
  humanEpoch: 0n,
};

/** A first-contact allow whose Target Limit is `target` (via the pending-intent term). */
function evaluationWithTarget(target: bigint, view: ChainView = firstContact): Evaluation {
  return evaluate({
    counterparty: PAYEE,
    amount: 1n * USDC,
    declaredIdentity: { name: "Acme Data, Inc." },
    now: NOW,
    lists,
    chain: { view, payeeIsContract: false, firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling },
    chainState: "live",
    hasHistory: true,
    identityBindings: [],
    pendingIntentTarget: target,
    policy: STANDARD_PRESET.offchain,
  });
}

async function appendDecision(store: PostgresRecordStore, e: Evaluation, scope: Scope = ENFORCED, at = NOW) {
  return store.append({
    scope,
    build: (seq, prevHash) =>
      buildDecisionRecord(
        {
          id: uuidv7(at),
          scope,
          createdAt: toWireTime(new Date(at)),
          trigger: "check",
          channel: "api",
          customerId: CUSTOMER,
          ...(scope.startsWith("enforced:") ? { policyWallet: WALLET } : {}),
          counterparty: PAYEE,
          amount: 1n * USDC,
          skippedQuestions: [],
          questionSetVersion: "v1",
          policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
          presetVersion: "standard@1",
          chainView: firstContact,
          chainState: "live",
          evaluation: e,
        },
        seq,
        prevHash,
      ),
    extraWrites: outboxExtraWrites(e, { now: new Date(at), humanEpoch: 0n }),
  });
}

async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  const records = new PostgresRecordStore(r.db);
  await records.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET });
  await records.ensureScope({ id: SHADOW, customerId: CUSTOMER });
  return { ...r, records, outbox: new PostgresOutboxStore(r.db) };
}

const H = (c: string) => `0x${c.repeat(64)}` as Hex;
const upsert = (db: HorosDb, p: { target: bigint; epoch?: bigint; pin?: boolean; rid: string; hash: Hex; lane?: "registrar" | "rules" }) =>
  upsertIntent(
    db,
    {
      scope: ENFORCED,
      counterparty: PAYEE,
      laneRole: p.lane ?? (p.pin === true ? "rules" : "registrar"),
      target: p.target,
      pin: p.pin ?? false,
      humanEpoch: p.epoch ?? 0n,
      recordId: p.rid,
      recordHash: p.hash,
      now: new Date(NOW),
    },
    uuidv7(NOW),
  );
const RID = (n: number) => `01926f3a-8000-7000-8000-${String(n).padStart(12, "0")}`;

describe("coalescing upsert", () => {
  test("register intents coalesce: LEAST target, all record ids, hash moves only on a strict drop", async () => {
    const { db, outbox } = await setup();
    await upsert(db, { target: 500n, rid: RID(1), hash: H("1") });
    await upsert(db, { target: 100n, rid: RID(2), hash: H("2") });
    await upsert(db, { target: 100n, rid: RID(3), hash: H("3") });
    await upsert(db, { target: 300n, rid: RID(4), hash: H("4") });
    const [row, ...rest] = await outbox.list(ENFORCED, PAYEE);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      target: 100n,
      pin: false,
      recordIds: [RID(1), RID(2), RID(3), RID(4)],
      createdByRecord: RID(1),
      sendRecordHash: H("2"),
      status: "pending",
      laneRole: "registrar",
    });
  });

  test("pin dominates: target 0, pin true, lane rules; later lower targets keep the pin's hash", async () => {
    const { db, outbox } = await setup();
    await upsert(db, { target: 50n, rid: RID(1), hash: H("1"), lane: "rules" });
    await upsert(db, { target: 0n, pin: true, rid: RID(2), hash: H("2") });
    await upsert(db, { target: 0n, rid: RID(3), hash: H("3"), lane: "registrar" });
    const [row] = await outbox.list(ENFORCED, PAYEE);
    expect(row).toMatchObject({ target: 0n, pin: true, sendRecordHash: H("2"), laneRole: "rules" });
  });

  test("a newer epoch replaces the target; an older epoch keeps it", async () => {
    const { db, outbox } = await setup();
    await upsert(db, { target: 50n, epoch: 1n, rid: RID(1), hash: H("1"), lane: "rules" });
    await upsert(db, { target: 80n, epoch: 2n, rid: RID(2), hash: H("2"), lane: "rules" });
    expect((await outbox.list(ENFORCED, PAYEE))[0]).toMatchObject({ target: 80n, humanEpoch: 2n, sendRecordHash: H("2") });
    await upsert(db, { target: 10n, epoch: 1n, rid: RID(3), hash: H("3"), lane: "rules" });
    expect((await outbox.list(ENFORCED, PAYEE))[0]).toMatchObject({ target: 80n, humanEpoch: 2n, sendRecordHash: H("2") });
  });

  test("outboxExtraWrites: nothing for a non-enforced scope or without an intent", async () => {
    const { records, outbox } = await setup();
    await appendDecision(records, evaluationWithTarget(100n * USDC), SHADOW);
    const noIntent = evaluate({
      counterparty: PAYEE,
      amount: 1n * USDC,
      now: NOW,
      lists,
      chainState: "live",
      hasHistory: true,
      identityBindings: [],
      policy: STANDARD_PRESET.offchain,
    });
    expect(noIntent.outboxIntent).toBeUndefined();
    await appendDecision(records, noIntent);
    expect(await outbox.list(ENFORCED)).toHaveLength(0);
    expect(await outbox.list(SHADOW)).toHaveLength(0);
  });

  test("two concurrent first-contact appends (500, 100) coalesce into one pending intent", async () => {
    const { records, outbox } = await setup();
    await concurrentCoalesce(records, outbox);
  });
});

async function concurrentCoalesce(records: PostgresRecordStore, outbox: PostgresOutboxStore) {
  const [a, b] = await Promise.all([
    appendDecision(records, evaluationWithTarget(500n * USDC)),
    appendDecision(records, evaluationWithTarget(100n * USDC)),
  ]);
  const rows = await outbox.list(ENFORCED, PAYEE);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  const small = "targetLimit" in a.record && a.record.targetLimit === String(100n * USDC) ? a : b;
  expect(row?.target).toBe(100n * USDC);
  expect(row?.status).toBe("pending");
  expect(new Set(row?.recordIds)).toEqual(new Set([a.record.id, b.record.id]));
  expect(row?.sendRecordHash).toBe(small.recordHash);
  const first = a.record.seq < b.record.seq ? a : b;
  const second = first === a ? b : a;
  expect(row?.createdByRecord).toBe(first.record.id);
  expect(await outbox.intentState(ENFORCED, PAYEE, first.record.id)).toBe("pending");
  expect(await outbox.intentState(ENFORCED, PAYEE, second.record.id)).toBe("coalesced");
}

describe("claim, lanes and transitions", () => {
  test("claim marks sending; a new decision then opens a new pending row that waits for the lane", async () => {
    const { db, outbox } = await setup();
    const now = new Date(NOW);
    await upsert(db, { target: 100n, rid: RID(1), hash: H("1") });
    const claimed = await outbox.claimNext(now);
    expect(claimed).toMatchObject({ status: "sending", target: 100n });
    await upsert(db, { target: 50n, rid: RID(2), hash: H("2") });
    const rows = await outbox.list(ENFORCED, PAYEE);
    expect(rows.map((r) => [r.status, r.target]).sort()).toEqual([
      ["pending", 50n],
      ["sending", 100n],
    ]);
    // The registrar lane is busy while sending, and while submitted without a tx hash.
    expect(await outbox.claimNext(now)).toBeUndefined();
    await outbox.markSubmitted(claimed?.id ?? "", "circle-tx-1", now);
    expect(await outbox.claimNext(now)).toBeUndefined();
    expect((await outbox.listAwaitingTx()).map((r) => r.id)).toEqual([claimed?.id]);
    await outbox.markTxHash(claimed?.id ?? "", H("e"), now);
    expect(await outbox.listAwaitingTx()).toEqual([]);
    const next = await outbox.claimNext(now);
    expect(next).toMatchObject({ target: 50n, recordIds: [RID(2)] });
    expect(await outbox.intentState(ENFORCED, PAYEE, RID(1))).toBe("pending");
    expect(await outbox.intentState(ENFORCED, PAYEE, RID(2))).toBe("pending");
    expect(await outbox.intentState(ENFORCED, PAYEE, RID(9))).toBe("none");
  });

  test("different lanes run in parallel; due time is honoured; retry and noop transitions", async () => {
    const { db, outbox, records } = await setup();
    const now = new Date(NOW);
    const OTHER: Hex = "0x2222222222222222222222222222222222222222";
    await upsert(db, { target: 100n, rid: RID(1), hash: H("1") });
    await upsertIntent(
      db,
      { scope: ENFORCED, counterparty: OTHER, laneRole: "rules", target: 0n, pin: true, humanEpoch: 0n, recordId: RID(2), recordHash: H("2"), now },
      uuidv7(NOW),
    );
    const a = await outbox.claimNext(now);
    const b = await outbox.claimNext(now);
    expect(new Set([a?.laneRole, b?.laneRole])).toEqual(new Set(["registrar", "rules"]));
    const reg = a?.laneRole === "registrar" ? a : b;
    const rules = reg === a ? b : a;
    await outbox.markRetry(reg?.id ?? "", { error: "boom", nextAttemptAt: new Date(NOW + 30_000), alerted: false }, now);
    expect(await outbox.get(reg?.id ?? "")).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });
    expect(await outbox.claimNext(now)).toBeUndefined();
    expect(await outbox.claimNext(new Date(NOW + 30_000))).toMatchObject({ id: reg?.id });
    await outbox.markNoop(reg?.id ?? "", now);
    expect(await outbox.intentState(ENFORCED, PAYEE, RID(1))).toBe("none");
    await expect(outbox.markNoop(reg?.id ?? "", now)).rejects.toThrow(/not in sending/);
    // markFailedInTx runs inside a record append.
    await records.append({
      scope: ENFORCED,
      build: (seq, prevHash) =>
        buildDecisionRecord(
          {
            id: uuidv7(NOW),
            scope: ENFORCED,
            createdAt: toWireTime(now),
            trigger: "check",
            channel: "worker",
            customerId: CUSTOMER,
            policyWallet: WALLET,
            counterparty: OTHER,
            skippedQuestions: [],
            questionSetVersion: "v1",
            policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
            presetVersion: "standard@1",
            chainState: "live",
            evaluation: evaluationWithTarget(1n),
          },
          seq,
          prevHash,
        ),
      extraWrites: (tx) => outbox.markFailedInTx(tx, rules?.id ?? "", "StaleEpoch", now),
    });
    expect(await outbox.intentState(ENFORCED, OTHER, RID(2))).toBe("failed");
  });

  test("recoverStale returns a crashed send to pending without counting an attempt", async () => {
    const { db, outbox } = await setup();
    await upsert(db, { target: 100n, rid: RID(1), hash: H("1") });
    const c = await outbox.claimNext(new Date(NOW));
    expect(await outbox.recoverStale(new Date(NOW), new Date(NOW + 1))).toBe(0);
    expect(await outbox.recoverStale(new Date(NOW + 1), new Date(NOW + 2))).toBe(1);
    expect(await outbox.get(c?.id ?? "")).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("recoverStale merges into a newer pending row instead of violating the pending-unique index", async () => {
    const { db, outbox } = await setup();
    await upsert(db, { target: 100n, rid: RID(1), hash: H("1") });
    const c = await outbox.claimNext(new Date(NOW));
    await upsert(db, { target: 50n, rid: RID(2), hash: H("2") });
    expect(await outbox.recoverStale(new Date(NOW + 1), new Date(NOW + 2))).toBe(1);
    const rows = await outbox.list(ENFORCED, PAYEE);
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ target: 50n, sendRecordHash: H("2"), recordIds: [RID(2), RID(1)], createdByRecord: RID(2) });
    expect(await outbox.get(c?.id ?? "")).toMatchObject({ status: "noop", mergedInto: pending[0]?.id, lastError: `merged into pending intent ${pending[0]?.id}` });
    expect(await outbox.intentState(ENFORCED, PAYEE, RID(1))).toBe("coalesced");
    expect(await outbox.intentState(ENFORCED, PAYEE, RID(2))).toBe("pending");
  });

  test("markRetry of a submitted intent merges into a newer pending row (lower in-flight target wins same-epoch)", async () => {
    const { db, outbox } = await setup();
    const now = new Date(NOW);
    await upsert(db, { target: 30n, rid: RID(1), hash: H("1") });
    const c = await outbox.claimNext(now);
    await outbox.markSubmitted(c?.id ?? "", "tx-1", now);
    await upsert(db, { target: 80n, rid: RID(2), hash: H("2") });
    await outbox.markRetry(c?.id ?? "", { error: "FAILED", nextAttemptAt: new Date(NOW + 30_000), alerted: false }, now);
    const pending = (await outbox.list(ENFORCED, PAYEE)).filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ target: 30n, sendRecordHash: H("1"), recordIds: [RID(2), RID(1)] });
    expect((await outbox.get(c?.id ?? ""))?.status).toBe("noop");
  });

  test("recordByHash returns the appended record", async () => {
    const { records, outbox } = await setup();
    const a = await appendDecision(records, evaluationWithTarget(100n * USDC));
    expect(await outbox.recordByHash(a.recordHash)).toEqual(a.record);
    expect(await outbox.recordByHash(H("f"))).toBeUndefined();
  });

  test("the check constraint rejects a pin with a non-zero target and a bad status", async () => {
    const { client } = await setup();
    const ins = (pin: boolean, target: string, status = "pending") =>
      client.exec(
        `INSERT INTO outbox_intent (id, scope, counterparty, lane_role, target, pin, human_epoch, record_ids, created_by_record,
           send_record_hash, status, next_attempt_at, created_at, updated_at)
         VALUES ('${RID(7)}', '${ENFORCED}', '${PAYEE}', 'rules', ${target}, ${pin}, 0, ARRAY['${RID(7)}'::uuid], '${RID(7)}',
           '${H("1")}', '${status}', now(), now(), now())`,
      );
    await expect(ins(true, "5")).rejects.toThrow(/outbox_intent_pin_target_zero/);
    await expect(ins(false, "5", "weird")).rejects.toThrow(/outbox_intent_status_valid/);
  });
});

const REAL_URL = process.env["HOROS_TEST_DATABASE_URL"];

describe.skipIf(REAL_URL === undefined || REAL_URL === "")("outbox coalescing (real Postgres)", () => {
  const dbName = `horos_test_${randomBytes(6).toString("hex")}`;
  let conn: ReturnType<typeof connectPostgres> | undefined;
  const admin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: REAL_URL });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${dbName}`));
    const url = new URL(REAL_URL ?? "");
    url.pathname = `/${dbName}`;
    const migrator = connectPostgres(url.toString(), 1);
    try {
      await runMigrations(migrator.db);
    } finally {
      await migrator.close();
    }
    url.searchParams.set("options", "-c role=horos_app");
    conn = connectPostgres(url.toString(), 10);
  });

  afterAll(async () => {
    await conn?.close();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
  });

  test("two concurrent first-contact appends coalesce into one pending intent (as horos_app)", async () => {
    if (conn === undefined) throw new Error("no connection");
    const records = new PostgresRecordStore(conn.db);
    await records.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET });
    await concurrentCoalesce(records, new PostgresOutboxStore(conn.db));
  });

  test("horos_app cannot delete intents", async () => {
    if (conn === undefined) throw new Error("no connection");
    await expect(conn.pool.query(`DELETE FROM outbox_intent`)).rejects.toThrow(/permission denied/);
  });
});
