import { buildDecisionRecord, buildExternalRecord, evaluate, STANDARD_PRESET, type ChainView, type ListSnapshot } from "@horos/core";
import { toWireTime, type Hex, type Scope } from "@horos/schema";
import { afterEach, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { foldMirror, PostgresIndexerStore, type MirrorState } from "./indexer-store.js";
import { PostgresOutboxStore, upsertIntent } from "./outbox-store.js";
import { PostgresRecordStore } from "./record-store.js";
import { freshDb, type TestClient } from "./test-db.js";

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

const ENFORCED: Scope = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
const CUSTOMER = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const WALLET: Hex = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const A: Hex = "0x1111111111111111111111111111111111111111";
const B: Hex = "0x2222222222222222222222222222222222222222";
const C: Hex = "0x3333333333333333333333333333333333333333";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const H = (c: string): Hex => `0x${c.repeat(64)}`;
const USDC = 1_000_000n;

const lists: ListSnapshot[] = [{ source: "ofac-sdn", snapshotId: "sdn-1", snapshotHash: H("a"), entries: new Map(), lastVerifiedAt: NOW.getTime() }];
const view: ChainView = {
  cpRemaining: 0n,
  walletRemaining: 5_000n * USDC,
  newPayeeRemaining: 10n,
  limit: 0n,
  pinned: false,
  registered: false,
  humanSet: false,
  humanEpoch: 0n,
};

async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  const records = new PostgresRecordStore(r.db);
  await records.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET });
  const store = new PostgresIndexerStore(r.db);
  const outbox = new PostgresOutboxStore(r.db);
  const decide = (counterparty: Hex = A) => {
    const e = evaluate({
      counterparty,
      amount: 1n * USDC,
      declaredIdentity: { name: "Acme Data, Inc." },
      now: NOW.getTime(),
      lists,
      chain: { view, payeeIsContract: false, firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling },
      chainState: "live",
      hasHistory: true,
      identityBindings: [],
      policy: STANDARD_PRESET.offchain,
    });
    return records.append({
      scope: ENFORCED,
      build: (seq, prevHash) =>
        buildDecisionRecord(
          {
            id: uuidv7(NOW.getTime()),
            scope: ENFORCED,
            createdAt: toWireTime(NOW),
            trigger: "check",
            channel: "api",
            customerId: CUSTOMER,
            policyWallet: WALLET,
            counterparty,
            amount: 1n * USDC,
            skippedQuestions: [],
            questionSetVersion: "v1",
            policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
            presetVersion: "standard@1",
            chainView: view,
            chainState: "live",
            evaluation: e,
          },
          seq,
          prevHash,
        ),
    });
  };
  /** An intent over `rs` (the first creates it), then claimed and submitted unless `submit: false`. */
  const intent = async (rs: { id: string; hash: Hex }[], opts: { target?: bigint; pin?: boolean; counterparty?: Hex; submit?: boolean } = {}) => {
    for (const r of rs) {
      await upsertIntent(
        db,
        {
          scope: ENFORCED,
          counterparty: opts.counterparty ?? A,
          laneRole: opts.pin === true ? "rules" : "registrar",
          target: opts.target ?? 100n * USDC,
          pin: opts.pin ?? false,
          humanEpoch: 0n,
          recordId: r.id,
          recordHash: r.hash,
          now: NOW,
        },
        uuidv7(NOW.getTime()),
      );
    }
    if (opts.submit !== false) {
      const claimed = await outbox.claimNext(NOW);
      if (claimed === undefined) throw new Error("nothing claimed");
      await outbox.markSubmitted(claimed.id, "tx-1", NOW);
      return claimed.id;
    }
    return (await outbox.list(ENFORCED, opts.counterparty ?? A))[0]?.id ?? "";
  };
  const db = r.db;
  return { ...r, records, store, outbox, decide, intent };
}

const at = (block: bigint, logIndex = 0) => ({ block, logIndex });

describe("foldMirror", () => {
  test("applies each event kind", () => {
    let s: MirrorState = foldMirror(undefined, { kind: "registered", limit: 100n }, at(10n));
    expect(s).toMatchObject({ registered: true, limit: 100n, firstRegisteredBlock: 10n, lastBlock: 10n, lastLogIndex: 0 });
    s = foldMirror(s, { kind: "tightened", limit: 40n }, at(11n));
    expect(s.limit).toBe(40n);
    s = foldMirror(s, { kind: "limit-set", limit: 300n, humanEpoch: 1n }, at(12n));
    expect(s).toMatchObject({ limit: 300n, humanSet: true, humanEpoch: 1n, registered: true });
    s = foldMirror(s, { kind: "pinned" }, at(13n));
    expect(s).toMatchObject({ pinned: true, limit: 0n });
    s = foldMirror(s, { kind: "unpin-requested", at: 1_790_000_000n }, at(14n));
    expect(s.unpinRequestedAt).toBe(1_790_000_000n);
    s = foldMirror(s, { kind: "pin-released", humanEpochBump: true }, at(15n));
    expect(s).toMatchObject({ pinned: false, unpinRequestedAt: null, humanEpoch: 2n, limit: 0n });
  });

  test("an older or equal position changes nothing (except an earlier first registration)", () => {
    const newer = foldMirror(undefined, { kind: "tightened", limit: 40n }, at(20n, 3));
    expect(foldMirror(newer, { kind: "tightened", limit: 90n }, at(20n, 3))).toBe(newer);
    expect(foldMirror(newer, { kind: "limit-set", limit: 900n, humanEpoch: 4n }, at(19n))).toBe(newer);
    const withFirst = foldMirror(newer, { kind: "registered", limit: 100n }, at(5n));
    expect(withFirst).toEqual({ ...newer, firstRegisteredBlock: 5n });
  });
});

describe("PostgresIndexerStore", () => {
  test("cursor: undefined, then set and moved", async () => {
    const { store } = await setup();
    expect(await store.cursor(WALLET)).toBeUndefined();
    await store.setCursor(WALLET, ENFORCED, 7n, NOW);
    await store.setCursor(WALLET, ENFORCED, 2007n, NOW);
    expect(await store.cursor(WALLET)).toBe(2007n);
  });

  test("confirm register: every contributing record gets a confirmed receipt; the intent is confirmed; replay adds nothing", async () => {
    const { store, outbox, decide, intent } = await setup();
    const r1 = await decide();
    const r2 = await decide();
    const id = await intent(
      [
        { id: r1.record.id, hash: r1.recordHash },
        { id: r2.record.id, hash: r2.recordHash },
      ],
      { target: 100n * USDC },
    );
    const sendHash = (await outbox.get(id))?.sendRecordHash ?? H("0");
    const m = await store.matchIntent(ENFORCED, A, sendHash, H("e"));
    expect(m?.intent.id).toBe(id);
    expect(m?.sentBy.id).toBe(id);
    await store.confirmIntent({ intentId: id, txHash: H("e"), blockNumber: 50n, onchainLimitAfter: 100n * USDC, now: NOW });
    expect(await outbox.get(id)).toMatchObject({ status: "confirmed", txHash: H("e") });
    expect(await outbox.intentState(ENFORCED, A, r1.record.id)).toBe("confirmed");
    expect(await outbox.intentState(ENFORCED, A, r2.record.id)).toBe("confirmed");
    const receipts = await store.receipts(ENFORCED);
    expect(receipts.map((r) => [r.recordId, r.status, r.onchainLimitAfter, r.txHash, r.blockNumber]).sort()).toEqual(
      [
        [r1.record.id, "confirmed", 100n * USDC, H("e"), 50n],
        [r2.record.id, "confirmed", 100n * USDC, H("e"), 50n],
      ].sort(),
    );
    // Replay: the intent still matches (confirmed by the same tx), confirm again inserts nothing.
    expect((await store.matchIntent(ENFORCED, A, sendHash, H("e")))?.intent.id).toBe(id);
    expect(await store.confirmIntent({ intentId: id, txHash: H("e"), blockNumber: 50n, onchainLimitAfter: 100n * USDC, now: NOW })).toBe(true);
    expect(await store.receipts(ENFORCED)).toHaveLength(2);
    // A different tx carrying the same hash does not match a confirmed intent, and is not confirmable.
    expect(await store.matchIntent(ENFORCED, A, sendHash, H("f"))).toBeUndefined();
    expect(await store.confirmIntent({ intentId: id, txHash: H("f"), blockNumber: 51n, onchainLimitAfter: 0n, now: NOW })).toBe(false);
  });

  test("matchIntent: same scope, counterparty and hash; pending|sending|submitted all match; a stored tx hash is only a hint", async () => {
    const { store, outbox, decide, intent } = await setup();
    const r = await decide();
    const id = await intent([{ id: r.record.id, hash: r.recordHash }], { submit: false });
    expect((await store.matchIntent(ENFORCED, A, r.recordHash, H("e")))?.intent.id).toBe(id); // pending (requeued)
    await outbox.claimNext(NOW);
    expect((await store.matchIntent(ENFORCED, A, r.recordHash, H("e")))?.intent.id).toBe(id); // sending
    await outbox.markSubmitted(id, "tx-1", NOW);
    await outbox.markTxHash(id, H("d"), NOW);
    expect((await store.matchIntent(ENFORCED, A, r.recordHash, H("e")))?.intent.id).toBe(id); // a replacement tx
    expect(await store.matchIntent(ENFORCED, B, r.recordHash, H("d"))).toBeUndefined();
    expect(await store.matchIntent(ENFORCED, A, H("9"), H("d"))).toBeUndefined();
    // Confirming overwrites the stored hint with the mined tx.
    expect(await store.confirmIntent({ intentId: id, txHash: H("e"), blockNumber: 5n, onchainLimitAfter: 1n, now: NOW })).toBe(true);
    expect(await outbox.get(id)).toMatchObject({ status: "confirmed", txHash: H("e") });
  });

  test("matchIntent follows merged_into from a merged noop row to the surviving intent", async () => {
    const { store, outbox, decide, intent, db } = await setup();
    const rOld = await decide();
    const oldId = await intent([{ id: rOld.record.id, hash: rOld.recordHash }]);
    const rNew = await decide();
    await upsertIntent(
      db,
      { scope: ENFORCED, counterparty: A, laneRole: "registrar", target: 50n, pin: false, humanEpoch: 0n, recordId: rNew.record.id, recordHash: rNew.recordHash, now: NOW },
      uuidv7(NOW.getTime()),
    );
    await outbox.markRetry(oldId, { error: "x", nextAttemptAt: NOW, alerted: false }, NOW);
    const merged = await outbox.get(oldId);
    expect(merged).toMatchObject({ status: "noop" });
    const m = await store.matchIntent(ENFORCED, A, rOld.recordHash, H("e"));
    expect(m?.sentBy.id).toBe(oldId);
    expect(m?.intent.id).toBe(merged?.mergedInto);
    expect(new Set(m?.intent.recordIds)).toEqual(new Set([rOld.record.id, rNew.record.id]));
  });

  test("Paid: matched to the DecisionRecord with that hash and counterparty, else null; idempotent; external records never match", async () => {
    const { store, records, decide } = await setup();
    const r = await decide();
    const ext = await records.append({
      scope: ENFORCED,
      build: (seq, prev) =>
        buildExternalRecord(
          {
            id: uuidv7(NOW.getTime()),
            scope: ENFORCED,
            createdAt: toWireTime(NOW),
            customerId: CUSTOMER,
            policyWallet: WALLET,
            actor: "human",
            actorAddress: C,
            txHash: H("c"),
            blockNumber: 3n,
            blockTimestamp: toWireTime(NOW),
            carriedHash: H("0"),
            events: [{ logIndex: 0, name: "LimitSet", args: { counterparty: A, oldLimit: "0", newLimit: "1", humanEpoch: "1", recordHash: H("0") } }],
          },
          seq,
          prev,
        ),
    });
    const base = { scope: ENFORCED, policyWallet: WALLET, counterparty: A, amount: 5n, blockNumber: 9n, blockTimestamp: NOW };
    await store.insertPaid({ ...base, txHash: H("1"), logIndex: 0, recordHash: r.recordHash });
    await store.insertPaid({ ...base, txHash: H("1"), logIndex: 0, recordHash: r.recordHash });
    await store.insertPaid({ ...base, txHash: H("2"), logIndex: 1, recordHash: H("9") });
    await store.insertPaid({ ...base, txHash: H("3"), logIndex: 0, recordHash: r.recordHash, counterparty: B });
    await store.insertPaid({ ...base, txHash: H("4"), logIndex: 0, recordHash: ext.recordHash });
    const paid = await store.paidEvents(ENFORCED);
    expect(paid.map((p) => [p.txHash, p.matchedRecordId]).sort()).toEqual([
      [H("1"), r.record.id],
      [H("2"), null],
      [H("3"), null],
      [H("4"), null],
    ]);
    expect(await store.hasExternalRecord(ENFORCED, H("c"))).toBe(true);
    expect(await store.hasExternalRecord(ENFORCED, H("d"))).toBe(false);
  });

  test("recordByHash never returns an ExternalRecord", async () => {
    const { outbox, records } = await setup();
    const ext = await records.append({
      scope: ENFORCED,
      build: (seq, prev) =>
        buildExternalRecord(
          {
            id: uuidv7(NOW.getTime()),
            scope: ENFORCED,
            createdAt: toWireTime(NOW),
            customerId: CUSTOMER,
            policyWallet: WALLET,
            actor: "human",
            actorAddress: C,
            txHash: H("c"),
            blockNumber: 3n,
            blockTimestamp: toWireTime(NOW),
            carriedHash: H("0"),
            events: [{ logIndex: 0, name: "PolicyChanged", args: { field: "0", oldValue: "1", newValue: "2", recordHash: H("0") } }],
          },
          seq,
          prev,
        ),
    });
    expect(await outbox.recordByHash(ext.recordHash)).toBeUndefined();
  });

  test("applyMirror: replay and out-of-order leave the newer state; monitored set = ever registered, by address", async () => {
    const { store } = await setup();
    await store.applyMirror(ENFORCED, B, { kind: "registered", limit: 100n }, at(10n), NOW);
    await store.applyMirror(ENFORCED, B, { kind: "tightened", limit: 40n }, at(12n), NOW);
    const before = await store.mirror(ENFORCED, B);
    await store.applyMirror(ENFORCED, B, { kind: "tightened", limit: 40n }, at(12n), NOW); // replay
    await store.applyMirror(ENFORCED, B, { kind: "registered", limit: 100n }, at(10n), NOW); // older
    expect(await store.mirror(ENFORCED, B)).toEqual(before);
    expect(before).toMatchObject({ registered: true, limit: 40n, firstRegisteredBlock: 10n, lastBlock: 12n });
    // Registered via a Human LimitSet (with its CounterpartyRegistered).
    await store.applyMirror(ENFORCED, A, { kind: "registered", limit: 300n }, at(11n, 0), NOW);
    await store.applyMirror(ENFORCED, A, { kind: "limit-set", limit: 300n, humanEpoch: 1n }, at(11n, 1), NOW);
    expect(await store.mirror(ENFORCED, A)).toMatchObject({ limit: 300n, humanSet: true, humanEpoch: 1n, firstRegisteredBlock: 11n });
    // Never registered: a tighten on an unknown address.
    await store.applyMirror(ENFORCED, C, { kind: "tightened", limit: 0n }, at(13n), NOW);
    expect(await store.monitoredSet(ENFORCED)).toEqual([A, B]);
  });

  test("reconcile: noop → noop receipt; merged noop → none; failed StaleEpoch → superseded_by_human; other failed → failed_terminal; idempotent", async () => {
    const { store, outbox, decide, intent, db, records } = await setup();
    const rNoop = await decide(A);
    const noopId = await intent([{ id: rNoop.record.id, hash: rNoop.recordHash }], { counterparty: A, submit: false });
    await outbox.claimNext(NOW);
    await outbox.markNoop(noopId, NOW);

    const rStale = await decide(B);
    const staleId = await intent([{ id: rStale.record.id, hash: rStale.recordHash }], { counterparty: B });
    await records.append({
      scope: ENFORCED,
      build: (seq, prev) => ({ ...rStale.record, id: uuidv7(NOW.getTime()), seq, prevHash: prev }),
      extraWrites: (tx) => outbox.markFailedInTx(tx, staleId, "StaleEpoch", NOW),
    });

    const rFail = await decide(C);
    const failId = await intent([{ id: rFail.record.id, hash: rFail.recordHash }], { counterparty: C });
    await records.append({
      scope: ENFORCED,
      build: (seq, prev) => ({ ...rFail.record, id: uuidv7(NOW.getTime()), seq, prevHash: prev }),
      extraWrites: (tx) => outbox.markFailedInTx(tx, failId, "NewPayeeCapReached", NOW),
    });

    // A merged noop: an in-flight row requeued into a newer pending row for the same counterparty.
    const D: Hex = "0x4444444444444444444444444444444444444444";
    const rOld = await decide(D);
    const oldId = await intent([{ id: rOld.record.id, hash: rOld.recordHash }], { counterparty: D });
    const rNew = await decide(D);
    await upsertIntent(
      db,
      { scope: ENFORCED, counterparty: D, laneRole: "registrar", target: 50n, pin: false, humanEpoch: 0n, recordId: rNew.record.id, recordHash: rNew.recordHash, now: NOW },
      uuidv7(NOW.getTime()),
    );
    await outbox.markRetry(oldId, { error: "x", nextAttemptAt: NOW, alerted: false }, NOW);
    expect(await outbox.get(oldId)).toMatchObject({ status: "noop" });

    expect(await store.reconcileReceipts(NOW)).toBe(3);
    expect(await store.reconcileReceipts(NOW)).toBe(0);
    const receipts = await store.receipts(ENFORCED);
    const byRecord = new Map(receipts.map((r) => [r.recordId, r.status]));
    expect(byRecord.get(rNoop.record.id)).toBe("noop");
    expect(byRecord.get(rStale.record.id)).toBe("superseded_by_human");
    expect(byRecord.get(rFail.record.id)).toBe("failed_terminal");
    expect(byRecord.has(rOld.record.id)).toBe(false);
    expect(receipts).toHaveLength(3);
  });

  test("boundWallets lists only bound bindings", async () => {
    const { store, client } = await setup();
    expect(await store.boundWallets()).toEqual([]);
    await client.exec(`INSERT INTO customer (id, payment_address) VALUES ('${CUSTOMER}', '0x705f7d75b1689c42034ca5102700be481edca2da')`);
    await client.exec(
      `INSERT INTO enforced_binding (customer_id, scope_id, status, policy_wallet, updated_at) VALUES ('${CUSTOMER}', '${ENFORCED}', 'bound', '${WALLET}', now())`,
    );
    expect(await store.boundWallets()).toEqual([{ scope: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET }]);
  });

  test("walletsWithSubmittedIntents: bound wallets with a sending or submitted intent, once each", async () => {
    const { store, client, outbox, decide, intent } = await setup();
    await client.exec(`INSERT INTO customer (id, payment_address) VALUES ('${CUSTOMER}', '0x705f7d75b1689c42034ca5102700be481edca2da')`);
    await client.exec(
      `INSERT INTO enforced_binding (customer_id, scope_id, status, policy_wallet, updated_at) VALUES ('${CUSTOMER}', '${ENFORCED}', 'bound', '${WALLET}', now())`,
    );
    const ra = await decide(A);
    const rb = await decide(B);
    await intent([{ id: ra.record.id, hash: ra.recordHash }], { submit: false });
    expect(await store.walletsWithSubmittedIntents()).toEqual([]); // pending only
    const claimed = await outbox.claimNext(NOW);
    if (claimed === undefined) throw new Error("nothing claimed");
    const bound = [{ scope: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET }];
    expect(await store.walletsWithSubmittedIntents()).toEqual(bound); // sending
    await outbox.markSubmitted(claimed.id, "tx-1", NOW);
    await intent([{ id: rb.record.id, hash: rb.recordHash }], { counterparty: B, pin: true }); // the Rules lane, so claimable
    expect(await store.walletsWithSubmittedIntents()).toEqual(bound); // two submitted intents, one wallet
    for (const id of [claimed.id, (await outbox.list(ENFORCED, B))[0]?.id ?? ""]) {
      await store.confirmIntent({ intentId: id, txHash: H("e"), blockNumber: 50n, onchainLimitAfter: 100n * USDC, now: NOW });
    }
    expect(await store.walletsWithSubmittedIntents()).toEqual([]);
  });
});
