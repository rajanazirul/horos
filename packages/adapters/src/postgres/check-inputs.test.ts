import { buildDecisionRecord, evaluate, SeqConflictError, STANDARD_PRESET, toOffchainPolicy, type ChainView, type ListSnapshot, type PolicyVersionStore } from "@horos/core";
import { CHECK_TYPES, checkDomain, toWireTime, type CheckMessage, type DeclaredIdentity, type Hex, type Scope } from "@horos/schema";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";
import { recoverCheckSigner } from "../chain/typed-data.js";
import { uuidv7 } from "../ids.js";
import { PostgresCheckInputs } from "./check-inputs.js";
import { PostgresIndexerStore } from "./indexer-store.js";
import { PostgresOutboxStore, upsertIntent } from "./outbox-store.js";
import { PostgresPolicyVersionStore } from "./policy-version-store.js";
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
  const decide = (counterparty: Hex, declaredIdentity?: DeclaredIdentity) => {
    const e = evaluate({
      counterparty,
      amount: 1n * USDC,
      ...(declaredIdentity === undefined ? {} : { declaredIdentity }),
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
            ...(declaredIdentity === undefined ? {} : { declaredIdentity }),
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
  return { ...r, inputs: new PostgresCheckInputs(r.db), indexer: new PostgresIndexerStore(r.db), outbox: new PostgresOutboxStore(r.db), decide };
}

describe("PostgresCheckInputs", () => {
  test("hasHistory: a registered mirror row or a Paid event", async () => {
    const { inputs, indexer, decide } = await setup();
    expect(await inputs.hasHistory(ENFORCED, A)).toBe(false);
    await indexer.applyMirror(ENFORCED, A, { kind: "registered", limit: 5n }, { block: 1n, logIndex: 0 }, NOW);
    expect(await inputs.hasHistory(ENFORCED, A)).toBe(true);
    const { recordHash } = await decide(B);
    expect(await inputs.hasHistory(ENFORCED, B)).toBe(false);
    await indexer.insertPaid({
      scope: ENFORCED,
      policyWallet: WALLET,
      txHash: H("e"),
      logIndex: 0,
      counterparty: B,
      amount: 1n,
      recordHash,
      blockNumber: 2n,
      blockTimestamp: NOW,
    });
    expect(await inputs.hasHistory(ENFORCED, B)).toBe(true);
  });

  test("identityBindings: only the requested keys, from records whose identity can share them", async () => {
    const { inputs, decide } = await setup();
    await decide(A, { name: "Acme Data, Inc.", domain: "www.acme.example" });
    await decide(B);
    await decide(B, { domain: "b.example" });
    await decide(B, { name: "ACME  data L.L.C." });
    await decide(A, { name: "Ｂeta Labs" }); // fullwidth B: NFKC → "beta labs"
    expect(await inputs.identityBindings(ENFORCED, [])).toEqual([]);
    expect(await inputs.identityBindings(ENFORCED, ["name:acme data", "domain:b.example"])).toEqual([
      { key: "name:acme data", address: A },
      { key: "domain:b.example", address: B },
      { key: "name:acme data", address: B },
    ]);
    expect(await inputs.identityBindings(ENFORCED, ["domain:acme.example"])).toEqual([{ key: "domain:acme.example", address: A }]);
    expect(await inputs.identityBindings(ENFORCED, ["name:beta labs"])).toEqual([{ key: "name:beta labs", address: A }]);
    expect(await inputs.identityBindings(ENFORCED, ["name:nobody"])).toEqual([]);
  });

  test("pendingIntentTarget, nonceUsed and intentTxHash", async () => {
    const { inputs, db, decide, outbox } = await setup();
    expect(await inputs.pendingIntentTarget(ENFORCED, A)).toBeUndefined();
    const { record, recordHash } = await decide(A);
    await upsertIntent(
      db,
      { scope: ENFORCED, counterparty: A, laneRole: "registrar", target: 7n, pin: false, humanEpoch: 0n, recordId: record.id, recordHash, now: NOW },
      uuidv7(NOW.getTime()),
    );
    expect(await inputs.pendingIntentTarget(ENFORCED, A)).toBe(7n);
    expect(await inputs.intentTxHash(ENFORCED, A, record.id)).toBeUndefined();
    const [row] = await outbox.list(ENFORCED, A);
    if (row === undefined) throw new Error("no intent");
    await outbox.claimNext(NOW);
    await outbox.markSubmitted(row.id, "circle-1", NOW);
    await outbox.markTxHash(row.id, H("f"), NOW);
    expect(await inputs.intentTxHash(ENFORCED, A, record.id)).toBe(H("f"));
    expect(await inputs.pendingIntentTarget(ENFORCED, A)).toBeUndefined();

    expect(await inputs.nonceUsed(ENFORCED, H("1"))).toBe(false);
    await new PostgresRecordStore(db).append({
      scope: ENFORCED,
      nonce: H("1"),
      build: (seq, prevHash) => ({ ...record, id: uuidv7(NOW.getTime()), seq, prevHash }),
    });
    expect(await inputs.nonceUsed(ENFORCED, H("1"))).toBe(true);
    expect(await inputs.nonceUsed(ENFORCED, H("2"))).toBe(false);
  });

  test("ensurePresetPolicy inserts the exact Standard Preset once (idempotent, race-safe)", async () => {
    const { inputs, db } = await setup();
    await Promise.all([inputs.ensurePresetPolicy(ENFORCED, NOW), inputs.ensurePresetPolicy(ENFORCED, NOW)]);
    await inputs.ensurePresetPolicy(ENFORCED, NOW);
    const active = await new PostgresPolicyVersionStore(db).active(ENFORCED);
    expect(active).toMatchObject({ seq: 1, activation: "preset", presetVersion: STANDARD_PRESET.version, policy: toOffchainPolicy(STANDARD_PRESET.offchain) });
    expect(await inputs.ensurePresetPolicy(ENFORCED, NOW)).toEqual(active);
  });

  test("ensurePresetPolicy losing the insert race (SeqConflictError) returns the winner's row", async () => {
    const { db } = await setup();
    const real = new PostgresPolicyVersionStore(db);
    const winner = await new PostgresCheckInputs(db).ensurePresetPolicy(ENFORCED, NOW);
    let reads = 0;
    const racing: PolicyVersionStore = {
      // The first read misses (the other writer has not committed yet); later reads see its row.
      active: async (s) => (reads++ === 0 ? undefined : real.active(s)),
      insert: async (row) => {
        throw new SeqConflictError(row.scope, row.seq);
      },
    };
    const got = await new PostgresCheckInputs(db, uuidv7, racing).ensurePresetPolicy(ENFORCED, NOW);
    expect(got).toEqual(winner);
    expect(reads).toBe(2);
  });
});

describe("recoverCheckSigner", () => {
  // Well-known Foundry/Anvil dev key. Test-only.
  const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const message: CheckMessage = { policyWallet: WALLET, counterparty: A, amount: 5n, declaredIdentityHash: H("0"), nonce: H("3"), expiry: 1_790_000_000n };
  const domain = checkDomain(5042002, WALLET);

  test("recovers the lowercase signer", async () => {
    const sig = await signer.signTypedData({ domain, types: CHECK_TYPES, primaryType: "Check", message });
    expect(await recoverCheckSigner(domain, message, sig)).toBe(signer.address.toLowerCase());
    expect(await recoverCheckSigner(domain, { ...message, amount: 6n }, sig)).not.toBe(signer.address.toLowerCase());
  });

  test("an unrecoverable signature gives undefined", async () => {
    expect(await recoverCheckSigner(domain, message, `0x${"1".repeat(130)}`)).toBeUndefined();
  });
});
