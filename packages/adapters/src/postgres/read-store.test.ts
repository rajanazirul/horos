import type { PGlite } from "@electric-sql/pglite";
import { buildExternalRecord, foldStatus } from "@horos/core";
import { DecisionRecord, toWireTime, type Decision, type Hex, type Scope } from "@horos/schema";
import { afterEach, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { PostgresIndexerStore } from "./indexer-store.js";
import { PostgresOutboxStore, upsertIntent } from "./outbox-store.js";
import { pageLimit, PostgresReadStore } from "./read-store.js";
import { PostgresRecordStore } from "./record-store.js";
import { freshDb } from "./test-db.js";

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

const ENFORCED: Scope = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
const CUSTOMER = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const SHADOW: Scope = `shadow:${CUSTOMER}`;
const WALLET: Hex = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const HUMAN: Hex = "0x2546bcd3c84621e976d8185a91a922ae77ecec30";
const A: Hex = "0x1111111111111111111111111111111111111111";
const B: Hex = "0x2222222222222222222222222222222222222222";
const C: Hex = "0x3333333333333333333333333333333333333333";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const H = (c: string): Hex => `0x${c.repeat(64)}`;

async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  const records = new PostgresRecordStore(r.db);
  await records.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET });
  await records.ensureScope({ id: SHADOW, customerId: CUSTOMER });
  const reads = new PostgresReadStore(r.db);
  const decide = (decision: Decision, counterparty: Hex = A, scope: Scope = ENFORCED) =>
    records.append({
      scope,
      build: (seq, prevHash) =>
        DecisionRecord.parse({
          schemaVersion: 1,
          id: uuidv7(NOW.getTime()),
          scope,
          seq,
          prevHash,
          createdAt: toWireTime(NOW),
          trigger: "check",
          customerId: CUSTOMER,
          ...(scope === ENFORCED ? { policyWallet: WALLET } : {}),
          counterparty,
          amount: "1000000",
          hardRules: [],
          signals: [],
          skippedQuestions: [],
          riskTier: decision === "hold" ? "high" : decision === "block" ? "severe" : "low",
          confidence: "1.0000",
          questionSetVersion: "v1",
          policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
          presetVersion: "standard@1",
          decision,
          reason: `test ${decision}`,
          chainState: "live",
          simulated: false,
          advisory: scope !== ENFORCED,
        }),
    });
  const external = (counterparty: Hex, newLimit: string, tx: string) =>
    records.append({
      scope: ENFORCED,
      build: (seq, prevHash) =>
        buildExternalRecord(
          {
            id: uuidv7(NOW.getTime()),
            scope: ENFORCED,
            createdAt: toWireTime(NOW),
            customerId: CUSTOMER,
            policyWallet: WALLET,
            actor: "human",
            actorAddress: HUMAN,
            txHash: H(tx),
            blockNumber: 10n,
            blockTimestamp: toWireTime(NOW),
            carriedHash: H("0"),
            events: [{ logIndex: 0, name: "LimitSet", args: { counterparty, oldLimit: "0", newLimit, humanEpoch: "1", recordHash: H("0") } }],
          },
          seq,
          prevHash,
        ),
    });
  return { ...r, records, reads, decide, external };
}

describe("pageLimit", () => {
  test("default 50, 1..100, else RangeError", () => {
    expect(pageLimit(undefined)).toBe(50);
    expect(pageLimit(100)).toBe(100);
    expect(() => pageLimit(0)).toThrow(RangeError);
    expect(() => pageLimit(101)).toThrow(RangeError);
    expect(() => pageLimit(1.5)).toThrow(RangeError);
  });
});

describe("PostgresReadStore", () => {
  test("scopeInfo", async () => {
    const { reads } = await setup();
    expect(await reads.scopeInfo(ENFORCED)).toEqual({ kind: "enforced", policyWallet: WALLET });
    expect(await reads.scopeInfo(SHADOW)).toEqual({ kind: "shadow" });
    expect(await reads.scopeInfo("advisory-public")).toBeUndefined();
  });

  test("listRecords pages 120 records by 50 in seq order", async () => {
    const { reads, decide } = await setup();
    for (let i = 0; i < 120; i++) await decide("allow");
    const p1 = await reads.listRecords(ENFORCED);
    expect(p1.items.map((r) => r.seq)).toEqual([...Array(50).keys()]);
    expect(p1.nextCursor).toBe(49);
    const p2 = await reads.listRecords(ENFORCED, { afterSeq: 49 });
    expect(p2.items[0]?.seq).toBe(50);
    expect(p2.nextCursor).toBe(99);
    const p3 = await reads.listRecords(ENFORCED, { afterSeq: 99 });
    expect(p3.items.map((r) => r.seq)).toEqual([...Array(20).keys()].map((i) => i + 100));
    expect(p3.nextCursor).toBeNull();
    expect((await reads.listRecords(ENFORCED, { afterSeq: 119 })).items).toEqual([]);
    const exact = await reads.listRecords(ENFORCED, { afterSeq: 19, limit: 100 });
    expect(exact.items).toHaveLength(100);
    expect(exact.nextCursor).toBeNull();
    expect(p1.items[0]?.recordHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("recordDetail: record with receipts (pin flag from the intent); unknown or malformed id → undefined", async () => {
    const { db, reads, decide } = await setup();
    const r1 = await decide("block");
    const r2 = await decide("block");
    for (const r of [r1, r2]) {
      await upsertIntent(
        db,
        { scope: ENFORCED, counterparty: A, laneRole: "rules", target: 0n, pin: true, humanEpoch: 0n, recordId: r.record.id, recordHash: r.recordHash, now: NOW },
        uuidv7(NOW.getTime()),
      );
    }
    const outbox = new PostgresOutboxStore(db);
    const claimed = await outbox.claimNext(NOW);
    if (claimed === undefined) throw new Error("nothing claimed");
    await outbox.markSubmitted(claimed.id, "tx-1", NOW);
    const indexer = new PostgresIndexerStore(db);
    await indexer.confirmIntent({ intentId: claimed.id, txHash: H("e"), blockNumber: 50n, onchainLimitAfter: 0n, now: NOW });
    const d = await reads.recordDetail(ENFORCED, r1.record.id);
    expect(d?.record.recordHash).toBe(r1.recordHash);
    expect(d?.receipts).toHaveLength(1);
    expect(d?.receipts[0]).toMatchObject({ status: "confirmed", pin: true, txHash: H("e"), onchainLimitAfter: 0n, blockNumber: 50n });
    expect(await reads.recordDetail(ENFORCED, uuidv7(NOW.getTime()))).toBeUndefined();
    expect(await reads.recordDetail(ENFORCED, "not-a-uuid")).toBeUndefined();
    expect(await reads.recordDetail(SHADOW, r1.record.id)).toBeUndefined();

    // Status inputs: both records then both confirmed pin receipts, interleaved by seq.
    const inputs = await reads.statusInputs(ENFORCED, A);
    expect(inputs.entries.map((e) => [e.seq, e.kind])).toEqual([
      [0, "record"],
      [0, "receipt"],
      [1, "record"],
      [1, "receipt"],
    ]);
    expect(foldStatus(inputs.entries, { pinned: false, chainState: "stale" }).status).toBe("blocked");
  });

  test("statusInputs: only this Counterparty's records, external records included, mirror row attached", async () => {
    const { reads, decide, external, db } = await setup();
    await decide("hold", A);
    await decide("allow", B);
    await external(A, "300", "a");
    const inputs = await reads.statusInputs(ENFORCED, A);
    expect(inputs.entries.map((e) => e.seq)).toEqual([0, 2]);
    expect(inputs.mirror).toBeUndefined();
    expect(foldStatus(inputs.entries, { pinned: false, chainState: "live" }).status).toBe("ok");
    await new PostgresIndexerStore(db).applyMirror(ENFORCED, A, { kind: "limit-set", limit: 300n, humanEpoch: 1n }, { block: 10n, logIndex: 0 }, NOW);
    expect((await reads.statusInputs(ENFORCED, A)).mirror).toEqual({ registered: true, limit: 300n, pinned: false });
    expect((await reads.statusInputs(ENFORCED, C)).entries).toEqual([]);
  });

  test("listCounterparties: mirror ∪ record counterparties, ordered by address, paged", async () => {
    const { reads, decide, db } = await setup();
    await decide("hold", C);
    await decide("allow", A);
    await decide("allow", A);
    await new PostgresIndexerStore(db).applyMirror(ENFORCED, B, { kind: "registered", limit: 5n }, { block: 1n, logIndex: 0 }, NOW);
    await decide("allow", B, SHADOW);
    const all = await reads.listCounterparties(ENFORCED);
    expect(all.items.map((i) => i.address)).toEqual([A, B, C]);
    expect(all.nextCursor).toBeNull();
    expect(all.items[0]?.entries).toHaveLength(2);
    expect(all.items[1]).toMatchObject({ entries: [], mirror: { registered: true, limit: 5n, pinned: false } });
    const p1 = await reads.listCounterparties(ENFORCED, { limit: 2 });
    expect(p1.items.map((i) => i.address)).toEqual([A, B]);
    expect(p1.nextCursor).toBe(B);
    const p2 = await reads.listCounterparties(ENFORCED, { after: B, limit: 2 });
    expect(p2.items.map((i) => i.address)).toEqual([C]);
    expect(p2.nextCursor).toBeNull();
    expect((await reads.listCounterparties(SHADOW)).items.map((i) => i.address)).toEqual([B]);
  });

  test("the counterparty index exists (migration 0005)", async () => {
    const { client } = await setup();
    const res = await client.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'decision_record_scope_counterparty_seq_idx'`);
    expect(res.rows[0]?.indexdef).toContain("(record ->> 'counterparty'::text)");
  });
});
