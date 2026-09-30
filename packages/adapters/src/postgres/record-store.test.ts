import { randomBytes } from "node:crypto";
import {
  buildDecisionRecord,
  buildExternalRecord,
  evaluate,
  NonceReplayError,
  STANDARD_PRESET,
  type ChainView,
  type Evaluation,
  type ListSnapshot,
  type ExternalRecordContext,
  type RecordContext,
} from "@horos/core";
import { recordHash, toWireTime, ZERO_BYTES32, type Scope } from "@horos/schema";
import { verifyChain } from "@horos/verify";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { connectPostgres } from "./connect.js";
import type { HorosDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { exportScopeChain, PostgresRecordStore, ScopeMismatchError } from "./record-store.js";
import { decisionRecord } from "./schema.js";
import { freshDb, testServerUrl, type TestClient } from "./test-db.js";

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

const ENFORCED: Scope = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
const SHADOW: Scope = "shadow:01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const CUSTOMER = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const PAYEE = "0x1111111111111111111111111111111111111111";
const DEMO_ADDR = "0xdddddddddddddddddddddddddddddddddddd0002";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const USDC = 1_000_000n;

const lists: ListSnapshot[] = [
  { source: "ofac-sdn", snapshotId: "sdn-1", snapshotHash: `0x${"a".repeat(64)}`, entries: new Map(), lastVerifiedAt: NOW },
  {
    source: "horos-demo-list",
    snapshotId: "demo-1",
    snapshotHash: `0x${"d".repeat(64)}`,
    entries: new Map([[DEMO_ADDR, ["HOROS DEMO ENTITY (TEST)"]]]),
    lastVerifiedAt: NOW,
  },
];
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

function evaluation(counterparty = PAYEE): Evaluation {
  return evaluate({
    counterparty,
    amount: 50n * USDC,
    declaredIdentity: { name: "Acme Data, Inc." },
    now: NOW,
    lists,
    chain: { view, payeeIsContract: false, firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling },
    chainState: "live",
    hasHistory: false,
    identityBindings: [],
    policy: STANDARD_PRESET.offchain,
  });
}

function context(scope: Scope, counterparty = PAYEE): RecordContext {
  return {
    id: uuidv7(NOW),
    scope,
    createdAt: toWireTime(new Date(NOW)),
    trigger: "check",
    channel: "api",
    customerId: CUSTOMER,
    policyWallet: WALLET,
    counterparty,
    amount: 50n * USDC,
    skippedQuestions: [],
    questionSetVersion: "v1",
    policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
    presetVersion: STANDARD_PRESET.version,
    chainView: view,
    chainState: "live",
    evaluation: evaluation(counterparty),
  };
}

function externalContext(): ExternalRecordContext {
  return {
    id: uuidv7(NOW),
    scope: ENFORCED,
    createdAt: toWireTime(new Date(NOW)),
    customerId: CUSTOMER,
    policyWallet: WALLET,
    actor: "human",
    actorAddress: "0x2546bcd3c84621e976d8185a91a922ae77ecec30",
    txHash: `0x${"e".repeat(64)}`,
    blockNumber: 42n,
    blockTimestamp: toWireTime(new Date(NOW - 1000)),
    carriedHash: `0x${"7".repeat(64)}`,
    events: [{ logIndex: 0, name: "LimitSet", args: { counterparty: PAYEE, oldLimit: "0", newLimit: "300", humanEpoch: "1", recordHash: `0x${"7".repeat(64)}` } }],
  };
}

const nonce = () => `0x${randomBytes(32).toString("hex")}`;

async function setupStore() {
  const r = await freshDb();
  clients.push(r.client);
  const store = new PostgresRecordStore(r.db);
  await store.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET });
  await store.ensureScope({ id: SHADOW, customerId: CUSTOMER });
  return { ...r, store };
}

const append = (store: PostgresRecordStore, scope: Scope, extra: { nonce?: string } = {}) => {
  const ctx = context(scope);
  return store.append({ scope, build: (seq, prev) => buildDecisionRecord(ctx, seq, prev), ...extra });
};

async function count(client: TestClient, table: string): Promise<number> {
  const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0]?.n ?? -1;
}

/** Shared by the one-connection and pooled runs: 50 concurrent appends form one linear, verifiable chain. */
async function fiftyConcurrent(db: HorosDb, store: PostgresRecordStore, scope: Scope): Promise<void> {
  const results = await Promise.all(Array.from({ length: 50 }, () => append(store, scope, { nonce: nonce() })));
  expect(results.map((r) => r.record.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  const chain = await store.readChain(scope);
  expect(chain.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  chain.forEach((r, i) => expect(r.prevHash).toBe(i === 0 ? ZERO_BYTES32 : chain[i - 1]?.recordHash));
  expect(verifyChain(await exportScopeChain(db, scope))).toEqual({ ok: true, count: 50 });
  expect(await store.head(scope)).toEqual({ nextSeq: 50, headHash: chain[49]?.recordHash });
}

describe("PostgresRecordStore (one connection)", () => {
  test("genesis: seq 0, zero prevHash; head advances to next_seq 1 with its hash", async () => {
    const { store } = await setupStore();
    expect(await store.head(ENFORCED)).toBeUndefined();
    const r = await append(store, ENFORCED);
    expect(r.record.seq).toBe(0);
    expect(r.record.prevHash).toBe(ZERO_BYTES32);
    expect(r.recordHash).toBe(recordHash(r.record));
    expect(await store.head(ENFORCED)).toEqual({ nextSeq: 1, headHash: r.recordHash });
    const [stored] = await store.readChain(ENFORCED);
    expect(stored?.record).toEqual(r.record);
    expect(stored?.recordHash).toBe(r.recordHash);
  });

  test("linked: three appends chain prevHash to the previous record_hash", async () => {
    const { store } = await setupStore();
    const rs = [await append(store, ENFORCED), await append(store, ENFORCED), await append(store, ENFORCED)];
    expect(rs.map((r) => r.record.seq)).toEqual([0, 1, 2]);
    expect(rs[1]?.record.prevHash).toBe(rs[0]?.recordHash);
    expect(rs[2]?.record.prevHash).toBe(rs[1]?.recordHash);
  });

  test("50 concurrent appends to one scope form a linear chain that verifies", async () => {
    const { db, store } = await setupStore();
    await fiftyConcurrent(db, store, ENFORCED);
  });

  test("two scopes interleaved keep independent chains, each from 0", async () => {
    const { db, store } = await setupStore();
    await Promise.all([append(store, ENFORCED), append(store, SHADOW), append(store, ENFORCED), append(store, SHADOW), append(store, SHADOW)]);
    expect((await store.readChain(ENFORCED)).map((r) => r.seq)).toEqual([0, 1]);
    expect((await store.readChain(SHADOW)).map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(verifyChain(await exportScopeChain(db, ENFORCED))).toEqual({ ok: true, count: 2 });
    expect(verifyChain(await exportScopeChain(db, SHADOW))).toEqual({ ok: true, count: 3 });
  });

  test("nonce replay: NonceReplayError, no record, head unchanged; the same nonce is fine in another scope", async () => {
    const { client, store } = await setupStore();
    const n = nonce();
    const first = await append(store, ENFORCED, { nonce: n });
    await expect(append(store, ENFORCED, { nonce: n })).rejects.toBeInstanceOf(NonceReplayError);
    await expect(append(store, ENFORCED, { nonce: n.toUpperCase().replace("0X", "0x") })).rejects.toBeInstanceOf(NonceReplayError);
    expect(await count(client, "decision_record")).toBe(1);
    expect(await count(client, "used_nonce")).toBe(1);
    expect(await store.head(ENFORCED)).toEqual({ nextSeq: 1, headHash: first.recordHash });
    await append(store, SHADOW, { nonce: n });
    expect(await count(client, "used_nonce")).toBe(2);
  });

  test("build throwing or returning an invalid record writes nothing", async () => {
    const { client, store } = await setupStore();
    await append(store, ENFORCED);
    const head = await store.head(ENFORCED);
    await expect(
      store.append({
        scope: ENFORCED,
        build: () => {
          throw new Error("boom");
        },
        nonce: nonce(),
      }),
    ).rejects.toThrow("boom");
    const ctx = context(ENFORCED);
    await expect(
      store.append({ scope: ENFORCED, build: (seq, prev) => ({ ...buildDecisionRecord(ctx, seq, prev), reason: "" }), nonce: nonce() }),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      store.append({ scope: ENFORCED, build: (seq, prev) => buildDecisionRecord(ctx, seq + 1, prev) }),
    ).rejects.toThrow(/does not extend/);
    expect(await count(client, "decision_record")).toBe(1);
    expect(await count(client, "used_nonce")).toBe(0);
    expect(await store.head(ENFORCED)).toEqual(head);
  });

  test("extraWrites runs in the transaction; when it throws, record, nonce and head roll back", async () => {
    const { client, store } = await setupStore();
    const ctx = context(ENFORCED);
    let visible: string[] = [];
    let seenHash: string | undefined;
    await store.append({
      scope: ENFORCED,
      build: (seq, prev) => buildDecisionRecord(ctx, seq, prev),
      extraWrites: async (tx, record, hash) => {
        // The record is already visible inside the same transaction, under the hash passed in.
        const rows = await tx
          .select({ id: decisionRecord.id, recordHash: decisionRecord.recordHash })
          .from(decisionRecord)
          .where(eq(decisionRecord.id, record.id));
        visible = rows.map((r) => `${r.id} ${r.recordHash}`);
        seenHash = hash;
      },
    });
    expect(seenHash).toBe(recordHash((await store.readChain(ENFORCED))[0]?.record));
    expect(visible).toEqual([`${ctx.id} ${seenHash ?? ""}`]);
    const head = await store.head(ENFORCED);
    const ctx2 = context(ENFORCED);
    await expect(
      store.append({
        scope: ENFORCED,
        build: (seq, prev) => buildDecisionRecord(ctx2, seq, prev),
        nonce: nonce(),
        extraWrites: async () => {
          throw new Error("outbox failed");
        },
      }),
    ).rejects.toThrow("outbox failed");
    expect(await count(client, "decision_record")).toBe(1);
    expect(await count(client, "used_nonce")).toBe(0);
    expect(await store.head(ENFORCED)).toEqual(head);
  });

  test("provenance: a Demo-List match in a shadow scope is simulated and advisory", async () => {
    const { store } = await setupStore();
    const ctx = context(SHADOW, DEMO_ADDR);
    const r = await store.append({ scope: SHADOW, build: (seq, prev) => buildDecisionRecord(ctx, seq, prev) });
    expect(r.record).toMatchObject({ simulated: true, advisory: true, decision: "block", targetLimit: "0" });
  });

  test("an unknown scope is rejected by the foreign key and writes nothing", async () => {
    const { client, store } = await setupStore();
    await expect(append(store, "shadow:01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e70")).rejects.toThrow();
    expect(await count(client, "record_chain_head")).toBe(0);
  });

  test("ensureScope rejects an existing id with a different customer or wallet", async () => {
    const { store } = await setupStore();
    const other = "0x1234567890123456789012345678901234567890";
    await expect(store.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: other })).rejects.toBeInstanceOf(ScopeMismatchError);
    await expect(
      store.ensureScope({ id: ENFORCED, customerId: "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e70", policyWallet: WALLET }),
    ).rejects.toBeInstanceOf(ScopeMismatchError);
    await expect(store.ensureScope({ id: SHADOW, customerId: "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e70" })).rejects.toBeInstanceOf(
      ScopeMismatchError,
    );
    // A shadow Scope without a Customer never gets that far: the table's CHECK rejects it.
    await expect(store.ensureScope({ id: SHADOW })).rejects.toThrow();
  });

  test("append rejects a record whose policyWallet or customerId disagree with its Scope, writing nothing", async () => {
    const { client, store } = await setupStore();
    const wrongWallet = { ...context(ENFORCED), policyWallet: "0x1234567890123456789012345678901234567890" };
    await expect(
      store.append({ scope: ENFORCED, build: (seq, prev) => buildDecisionRecord(wrongWallet, seq, prev), nonce: nonce() }),
    ).rejects.toThrow(/policyWallet differs/);
    const wrongCustomer = { ...context(ENFORCED), customerId: "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e70" };
    await expect(
      store.append({ scope: ENFORCED, build: (seq, prev) => buildDecisionRecord(wrongCustomer, seq, prev), nonce: nonce() }),
    ).rejects.toThrow(/customerId differs/);
    expect(await count(client, "decision_record")).toBe(0);
    expect(await count(client, "used_nonce")).toBe(0);
    expect(await count(client, "record_chain_head")).toBe(0);
  });

  test("ensureScope is idempotent and records kind, customer and wallet", async () => {
    const { client, store } = await setupStore();
    await store.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET.toUpperCase().replace("0X", "0x") });
    await store.ensureScope({ id: "advisory-public" });
    const rows = await client.query(`SELECT id, kind, customer_id, policy_wallet FROM scope ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: "advisory-public", kind: "advisory-public", customer_id: null, policy_wallet: null },
      { id: ENFORCED, kind: "enforced", customer_id: CUSTOMER, policy_wallet: WALLET },
      { id: SHADOW, kind: "shadow", customer_id: CUSTOMER, policy_wallet: null },
    ]);
  });

  test("a chain mixing DecisionRecords and ExternalRecords exports, verifies, and breaks where an external record is edited", async () => {
    const { db, store, client } = await setupStore();
    await append(store, ENFORCED);
    const ext = await store.append({ scope: ENFORCED, build: (seq, prev) => buildExternalRecord(externalContext(), seq, prev) });
    expect(ext.record).toMatchObject({ recordType: "external", seq: 1, counterparty: PAYEE });
    await append(store, ENFORCED);
    const text = await exportScopeChain(db, ENFORCED);
    expect(verifyChain(text)).toEqual({ ok: true, count: 3 });
    expect((await store.readChain(ENFORCED)).map((r) => "recordType" in r.record)).toEqual([false, true, false]);
    const lines = text.trimEnd().split("\n");
    const obj = JSON.parse(lines[1] ?? "") as { record: { blockNumber: number } };
    obj.record.blockNumber += 1;
    lines[1] = JSON.stringify(obj);
    expect(verifyChain(lines)).toEqual({ ok: false, firstBreak: { line: 2, seq: 1, reason: "hash mismatch" } });
    // One ExternalRecord per (Scope, tx): a second append for the same tx is rejected and writes nothing.
    await expect(store.append({ scope: ENFORCED, build: (seq, prev) => buildExternalRecord(externalContext(), seq, prev) })).rejects.toThrow();
    expect(await count(client, "decision_record")).toBe(3);
  });

  test("an ExternalRecord naming another PolicyWallet is rejected", async () => {
    const { client, store } = await setupStore();
    const wrong = { ...externalContext(), policyWallet: "0x1234567890123456789012345678901234567890" };
    await expect(store.append({ scope: ENFORCED, build: (seq, prev) => buildExternalRecord(wrong, seq, prev) })).rejects.toThrow(/policyWallet differs/);
    expect(await count(client, "decision_record")).toBe(0);
  });

  test("export round-trips through verifyChain; a tampered reason breaks at that line", async () => {
    const { db, store } = await setupStore();
    for (let i = 0; i < 3; i++) await append(store, ENFORCED);
    const text = await exportScopeChain(db, ENFORCED);
    expect(text.endsWith("\n")).toBe(true);
    expect(verifyChain(text)).toEqual({ ok: true, count: 3 });
    const lines = text.trimEnd().split("\n");
    const obj = JSON.parse(lines[1] ?? "") as { record: { reason: string } };
    obj.record.reason = `${obj.record.reason} (edited)`;
    lines[1] = JSON.stringify(obj);
    expect(verifyChain(lines)).toEqual({ ok: false, firstBreak: { line: 2, seq: 1, reason: "hash mismatch" } });
  });
});

const REAL_URL = testServerUrl();

describe("PostgresRecordStore (real Postgres)", () => {
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
    const url = new URL(REAL_URL);
    url.pathname = `/${dbName}`;
    // Migrations run as the connecting (migrator) role; the appends then run as horos_app, so the
    // production grants are what the test exercises.
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

  test("sessions run as horos_app, which cannot update or delete records", async () => {
    if (conn === undefined) throw new Error("no connection");
    const r = await conn.pool.query<{ u: string }>(`SELECT current_user AS u`);
    expect(r.rows[0]?.u).toBe("horos_app");
    await expect(conn.pool.query(`DELETE FROM decision_record`)).rejects.toThrow(/permission denied/);
    await expect(conn.pool.query(`UPDATE used_nonce SET nonce = nonce`)).rejects.toThrow(/permission denied/);
  });

  test("50 concurrent appends to one scope form a linear chain that verifies", async () => {
    if (conn === undefined) throw new Error("no connection");
    const store = new PostgresRecordStore(conn.db);
    await store.ensureScope({ id: ENFORCED, customerId: CUSTOMER, policyWallet: WALLET });
    await fiftyConcurrent(conn.db, store, ENFORCED);
  });

  test("nonce replay rolls back on real Postgres too", async () => {
    if (conn === undefined) throw new Error("no connection");
    const store = new PostgresRecordStore(conn.db);
    await store.ensureScope({ id: SHADOW, customerId: CUSTOMER });
    const n = nonce();
    const results = await Promise.allSettled([append(store, SHADOW, { nonce: n }), append(store, SHADOW, { nonce: n })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof NonceReplayError).toBe(true);
    expect(await store.head(SHADOW)).toMatchObject({ nextSeq: 1 });
  });
});
