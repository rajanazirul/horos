// Story 2.7 indexer: every I/O-matrix row with a fake chain reader, pipeline fixtures (core `evaluate` +
// `buildDecisionRecord` through `outboxExtraWrites`) and the real Story 2.6 outbox sender, on PGlite.
import type { PGlite } from "@electric-sql/pglite";
import {
  outboxExtraWrites,
  PostgresAccountStore,
  PostgresIndexerStore,
  PostgresJobStore,
  PostgresListStore,
  PostgresOutboxStore,
  PostgresRecordStore,
  uuidv7,
  type FetchSdn,
} from "@horos/adapters";
import {
  buildDecisionRecord,
  evaluate,
  STANDARD_PRESET,
  type ChainReader,
  type ChainView,
  type ChainWriter,
  type Evaluation,
  type FounderAlert,
  type ListSnapshot,
  type LivePolicy,
  type Notifier,
  type PolicyWalletLog,
  type ProvisionedKeys,
  type SimulateResult,
  type WalletRoles,
  type WriteRequest,
  type WriteStatus,
} from "@horos/core";
import { isExternalRecord, toWireTime, ZERO_BYTES32, type ExternalRecord, type Hex, type Scope } from "@horos/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migratedClient, migratedDump } from "./migrated-db.test-helpers.js";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { findDeployBlock, UNRECOGNISED_WRITE_ALERT_JOB } from "./indexer.js";
import { createWorker } from "./tick.js";

const USDC = 1_000_000n;
const PAY: Hex = "0x705f7d75b1689c42034ca5102700be481edca2da";
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const HUMAN: Hex = `0x${"9".repeat(40)}`;
const STRANGER: Hex = `0x${"5".repeat(40)}`;
const A: Hex = "0x1111111111111111111111111111111111111111";
const B: Hex = "0x2222222222222222222222222222222222222222";
const C: Hex = "0x3333333333333333333333333333333333333333";
const T0 = new Date("2026-09-28T12:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const H = (c: string): Hex => `0x${c.repeat(64)}`;
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-registrar", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-model", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-rules", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};
const DEPLOY_BLOCK = 3n;

const sdn = (entries: [string, string[]][] = []): ListSnapshot => ({
  source: "ofac-sdn",
  snapshotId: `sdn-${entries.length}`,
  snapshotHash: `0x${"a".repeat(64)}`,
  entries: new Map(entries),
  lastVerifiedAt: T0.getTime(),
});

const unregistered: ChainView = {
  cpRemaining: 0n,
  walletRemaining: 5_000n * USDC,
  newPayeeRemaining: 10n,
  limit: 0n,
  pinned: false,
  registered: false,
  humanSet: false,
  humanEpoch: 0n,
};
const registered = (limit: bigint, humanEpoch = 0n): ChainView => ({ ...unregistered, registered: true, limit, cpRemaining: limit, humanEpoch });

/** A fake chain: live views for the sender, and a log history for the indexer. */
class FakeChain implements ChainReader {
  views = new Map<string, ChainView>();
  simulateResult: SimulateResult = { ok: true };
  head = 10n;
  deployBlock = DEPLOY_BLOCK;
  history: (PolicyWalletLog & { wallet: Hex })[] = [];
  senders = new Map<string, Hex>();
  logCalls: [bigint, bigint][] = [];
  failLogs = false;
  failWallets = new Set<Hex>();
  roleSet: WalletRoles = { payment: PAY, registrar: KEYS.registrar.address, model: KEYS.model.address, rules: KEYS.rules.address, human: HUMAN };
  /** Role holders as of a block; blocks not listed use `roleSet`. */
  rolesByBlock = new Map<bigint, WalletRoles>();
  private nextTx = 1;

  /** Append one mined tx at `block` (default: the head, which then advances) and return its hash. */
  mine(from: Hex, events: { name: PolicyWalletLog["name"]; args: Record<string, string> }[], block?: bigint, wallet: Hex = WALLET): Hex {
    const b = block ?? this.head;
    const txHash: Hex = `0x${this.nextTx.toString(16).padStart(64, "0")}`;
    this.nextTx++;
    const base = this.history.filter((l) => l.blockNumber === b).length;
    events.forEach((e, i) => this.history.push({ ...e, txHash, logIndex: base + i, blockNumber: b, wallet }));
    this.senders.set(txHash, from);
    if (block === undefined) this.head++;
    return txHash;
  }

  async remaining(_w: Hex, a: Hex) {
    return this.views.get(a) ?? unregistered;
  }
  async roles(): Promise<WalletRoles> {
    return this.roleSet;
  }
  async policy(): Promise<LivePolicy> {
    return { firstContactCeiling: 500n * USDC, walletPeriodCap: 5_000n * USDC, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n };
  }
  async hasCode() {
    return false;
  }
  async simulate(): Promise<SimulateResult> {
    return this.simulateResult;
  }
  async latestBlock() {
    return this.head;
  }
  async logs(w: Hex, from: bigint, to: bigint): Promise<PolicyWalletLog[]> {
    this.logCalls.push([from, to]);
    if (this.failLogs || this.failWallets.has(w)) throw new Error("rpc down");
    return this.history
      .filter((l) => l.wallet === w && l.blockNumber >= from && l.blockNumber <= to)
      .map((l): PolicyWalletLog => ({ name: l.name, args: l.args, txHash: l.txHash, logIndex: l.logIndex, blockNumber: l.blockNumber }))
      .sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  }
  async blockTimestamp(block: bigint) {
    return 1_790_000_000n + block * 2n;
  }
  async txFrom(txHash: Hex) {
    const f = this.senders.get(txHash);
    if (f === undefined) throw new Error("unknown tx");
    return f;
  }
  async rolesAt(_w: Hex, block: bigint) {
    return this.rolesByBlock.get(block) ?? this.roleSet;
  }
  async hasCodeAt(_a: Hex, block: bigint) {
    return block >= this.deployBlock;
  }
}

class FakeWriter implements ChainWriter {
  sent: WriteRequest[] = [];
  statusResult: WriteStatus = { state: "pending" };
  async send(req: WriteRequest) {
    this.sent.push(req);
    return { txId: `tx-${this.sent.length}` };
  }
  async status() {
    return this.statusResult;
  }
}

class RecordingNotifier implements Notifier {
  readonly alerts: FounderAlert[] = [];
  failNext = 0;
  async notify(alert: FounderAlert) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("webhook down");
    }
    this.alerts.push(alert);
  }
}

/** A job store whose `ensureJob` can fail (a crash between the ExternalRecord append and the alert job). */
class CrashyJobStore extends PostgresJobStore {
  failEnsure = 0;
  override async ensureJob(kind: string, window: string, now: Date): Promise<boolean> {
    if (this.failEnsure > 0 && kind === UNRECOGNISED_WRITE_ALERT_JOB) {
      this.failEnsure--;
      throw new Error("crash before the alert job");
    }
    return super.ensureJob(kind, window, now);
  }
}

const noFetch: FetchSdn = async () => ({ status: 304 });

// Migrate once for the file, outside any single test's timeout.
beforeAll(async () => {
  await migratedDump();
});

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

async function setup(opts: { lists?: ListSnapshot[]; chunkSize?: bigint } = {}) {
  const client = await migratedClient();
  clients.push(client);
  const db = drizzle(client);
  const accounts = new PostgresAccountStore(db);
  const records = new PostgresRecordStore(db);
  const outbox = new PostgresOutboxStore(db);
  const store = new PostgresIndexerStore(db);
  const jobs = new CrashyJobStore(db);
  const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T0 });
  await accounts.setKeys(binding.customerId, KEYS, T0);
  const bound = await accounts.bind(binding.customerId, WALLET, T0);
  const scope = bound.scopeId as Scope;
  const chain = new FakeChain();
  const writer = new FakeWriter();
  const notifier = new RecordingNotifier();
  const lists = opts.lists ?? [sdn()];
  const worker = createWorker({
    jobs,
    lists: new PostgresListStore(db),
    fetchSdn: noFetch,
    notifier,
    newId: () => uuidv7(),
    outbox: { accounts, outbox, records, reader: chain, writer, notifier, loadLists: async () => lists, newId: uuidv7 },
    indexer: { store, jobs, records, reader: chain, notifier, newId: uuidv7, ...(opts.chunkSize === undefined ? {} : { chunkSize: opts.chunkSize }) },
  });

  async function decide(p: { target: bigint; counterparty?: Hex; view?: ChainView; lists?: ListSnapshot[]; now?: Date }) {
    const view = p.view ?? unregistered;
    const now = p.now ?? T0;
    const counterparty = p.counterparty ?? A;
    const e: Evaluation = evaluate({
      counterparty,
      amount: 1n * USDC,
      declaredIdentity: { name: "Acme Data, Inc." },
      now: now.getTime(),
      lists: p.lists ?? lists,
      chain: { view, payeeIsContract: false, firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling },
      chainState: "live",
      hasHistory: true,
      identityBindings: [],
      pendingIntentTarget: p.target,
      policy: STANDARD_PRESET.offchain,
    });
    return records.append({
      scope,
      build: (seq, prevHash) =>
        buildDecisionRecord(
          {
            id: uuidv7(now.getTime()),
            scope,
            createdAt: toWireTime(now),
            trigger: "check",
            channel: "api",
            customerId: binding.customerId,
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
      extraWrites: outboxExtraWrites(e, { now, humanEpoch: view.humanEpoch }),
    });
  }

  const externals = async (): Promise<ExternalRecord[]> =>
    (await records.readChain(scope)).map((r) => r.record).filter((r): r is ExternalRecord => isExternalRecord(r));

  /** Mine the write the sender submitted (`sent[i]`) as its PolicyWallet events, and report the tx hash via the writer. */
  function mineSent(i = 0, events?: { name: PolicyWalletLog["name"]; args: Record<string, string> }[]): Hex {
    const req = writer.sent[i];
    if (req === undefined) throw new Error("nothing sent");
    const call = req.call;
    const evs =
      events ??
      (call.fn === "register"
        ? [{ name: "CounterpartyRegistered" as const, args: { counterparty: call.counterparty, limit: call.limit.toString(), recordHash: call.recordHash } }]
        : call.fn === "tighten"
          ? [{ name: "LimitTightened" as const, args: { counterparty: call.counterparty, oldLimit: "0", newLimit: call.limit.toString(), recordHash: call.recordHash } }]
          : [{ name: "CounterpartyPinned" as const, args: { counterparty: call.counterparty, recordHash: call.recordHash } }]);
    const txHash = chain.mine(req.signer.address, evs);
    writer.statusResult = { state: "complete", txHash };
    return txHash;
  }

  return { db, client, scope, binding: bound, accounts, records, outbox, store, jobs, chain, writer, notifier, worker, decide, externals, mineSent };
}

describe("indexer: matched Horos writes", () => {
  test("2.6 race (500, 100 → one register(a, 100)): both records get confirmed receipts at 100, intentState confirmed", async () => {
    const s = await setup();
    const [r500, r100] = await Promise.all([s.decide({ target: 500n * USDC }), s.decide({ target: 100n * USDC })]);
    await s.worker.tick(T0);
    expect(s.writer.sent.map((w) => w.call)).toEqual([{ fn: "register", counterparty: A, limit: 100n * USDC, recordHash: r100.recordHash }]);
    const txHash = s.mineSent();
    const report = await s.worker.tick(at(1));
    expect(report.indexer?.wallets).toEqual([expect.objectContaining({ confirmed: 1, external: 0 })]);
    const receipts = await s.store.receipts(s.scope);
    expect(receipts.map((r) => [r.recordId, r.status, r.onchainLimitAfter, r.txHash]).sort()).toEqual(
      [
        [r500.record.id, "confirmed", 100n * USDC, txHash],
        [r100.record.id, "confirmed", 100n * USDC, txHash],
      ].sort(),
    );
    expect(await s.outbox.intentState(s.scope, A, r500.record.id)).toBe("confirmed");
    expect(await s.outbox.intentState(s.scope, A, r100.record.id)).toBe("confirmed");
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "confirmed", txHash });
    expect(await s.store.mirror(s.scope, A)).toMatchObject({ registered: true, limit: 100n * USDC, pinned: false });
    expect(await s.externals()).toEqual([]);
  });

  test("the indexer confirms even before the sender has stored the tx hash (status still submitted)", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.mineSent();
    s.writer.statusResult = { state: "pending" }; // Circle has not reported the hash yet
    await s.worker.tick(at(1));
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("confirmed");
  });

  test("a write requeued to pending (Circle reported FAILED) that was mined anyway → confirmed receipts, no ExternalRecord, no alert", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.writer.statusResult = { state: "failed", error: "FAILED" };
    await s.worker.tick(at(1));
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "pending" });
    const txHash = s.mineSent();
    await s.worker.tick(at(2));
    expect(await s.store.receipts(s.scope, r.record.id)).toEqual([expect.objectContaining({ status: "confirmed", txHash, onchainLimitAfter: 100n * USDC })]);
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("confirmed");
    expect(await s.externals()).toEqual([]);
    expect(s.notifier.alerts).toEqual([]);
  });

  /** r1's register(A, 100) is in flight; r2 (target `t2`) opens a new pending row; Circle then reports r1's write FAILED. */
  async function mergedAfterFailure(t2: bigint) {
    const s = await setup();
    const r1 = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0); // register(A, 100, r1) submitted
    const r2 = await s.decide({ target: t2, now: at(1) }); // a new pending row while r1's write is in flight
    s.writer.statusResult = { state: "failed", error: "FAILED" };
    s.chain.simulateResult = { ok: false, revert: "AlreadyRegistered" }; // keep the survivor unsent this tick
    await s.worker.tick(at(2)); // r1's row requeued → merged into r2's row (noop + merged_into)
    s.chain.simulateResult = { ok: true };
    const merged = (await s.outbox.list(s.scope, A)).find((x) => x.status === "noop");
    expect(merged?.mergedInto).toBeTruthy();
    s.mineSent(0); // the first register was mined after all
    s.chain.views.set(A, registered(100n * USDC));
    await s.worker.tick(at(3));
    return { s, r1, r2, mergedId: merged?.id ?? "", survivorId: merged?.mergedInto ?? "" };
  }

  test("merged noop mined, survivor target ≥ mined limit → the surviving intent is confirmed, covering all its records", async () => {
    const { s, r1, r2, survivorId } = await mergedAfterFailure(200n * USDC); // survivor target LEAST(200, 100) = 100
    expect(await s.outbox.get(survivorId)).toMatchObject({ status: "confirmed", target: 100n * USDC });
    const receipts = await s.store.receipts(s.scope);
    expect(receipts.map((x) => [x.recordId, x.status, x.onchainLimitAfter, x.outboxIntentId]).sort()).toEqual(
      [
        [r1.record.id, "confirmed", 100n * USDC, survivorId],
        [r2.record.id, "confirmed", 100n * USDC, survivorId],
      ].sort(),
    );
    expect(await s.externals()).toEqual([]);
    expect(s.notifier.alerts).toEqual([]);
  });

  test("merged noop mined, survivor target 40 < mined 100 → merged row's records confirmed at 100; survivor stays pending, then tighten(A, 40)", async () => {
    const { s, r1, r2, mergedId, survivorId } = await mergedAfterFailure(40n * USDC);
    const receipts = await s.store.receipts(s.scope);
    expect(receipts.map((x) => [x.recordId, x.status, x.onchainLimitAfter, x.outboxIntentId])).toEqual([[r1.record.id, "confirmed", 100n * USDC, mergedId]]);
    expect(await s.outbox.get(survivorId)).toMatchObject({ status: "pending", target: 40n * USDC });
    expect(await s.outbox.intentState(s.scope, A, r2.record.id)).not.toBe("confirmed");
    expect(await s.externals()).toEqual([]);
    expect(s.notifier.alerts).toEqual([]);
    // Replaying the chunk adds nothing.
    await s.store.setCursor(WALLET, s.scope, DEPLOY_BLOCK, at(4));
    await s.worker.tick(at(5));
    expect(await s.store.receipts(s.scope)).toHaveLength(1);
    // Once due, the sender sends the tighter Limit.
    await s.worker.tick(at(120));
    expect(s.writer.sent.at(-1)?.call).toMatchObject({ fn: "tighten", counterparty: A, limit: 40n * USDC });
  });

  test("a stored tx hash that differs from the mined tx (a replacement) is only a hint: still confirmed, hash overwritten", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.writer.statusResult = { state: "complete", txHash: H("d") };
    await s.worker.tick(at(1));
    expect((await s.outbox.list(s.scope, A))[0]?.txHash).toBe(H("d"));
    const call = s.writer.sent[0]?.call;
    if (call?.fn !== "register") throw new Error("expected register");
    const mined = s.chain.mine(KEYS.registrar.address, [
      { name: "CounterpartyRegistered", args: { counterparty: A, limit: call.limit.toString(), recordHash: call.recordHash } },
    ]);
    await s.worker.tick(at(2));
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("confirmed");
    expect((await s.outbox.list(s.scope, A))[0]?.txHash).toBe(mined);
    expect(await s.externals()).toEqual([]);
  });

  test("a Human setLimit(a, l ≤ target) carrying an in-flight register's hash is never a Horos write", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    const sendHash = (await s.outbox.list(s.scope, A))[0]?.sendRecordHash ?? H("0");
    s.chain.mine(HUMAN, [
      { name: "CounterpartyRegistered", args: { counterparty: A, limit: "50000000", recordHash: sendHash } },
      { name: "LimitSet", args: { counterparty: A, oldLimit: "0", newLimit: "50000000", humanEpoch: "1", recordHash: sendHash } },
    ]);
    await s.worker.tick(at(1));
    expect(await s.store.receipts(s.scope)).toEqual([]);
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("pending");
    const exts = await s.externals();
    expect(exts).toHaveLength(1);
    expect(exts[0]?.events.map((e) => e.name)).toEqual(["CounterpartyRegistered", "LimitSet"]);
    expect(exts[0]).toMatchObject({ actor: "human", carriedHash: sendHash });
  });

  test("pin: Registered(a, 0) + Pinned(a) in one tx → confirmed receipts at 0, mirror pinned, no external record", async () => {
    const listed = [sdn([[A, ["EXAMPLE SANCTIONED ENTITY"]]])];
    const s = await setup({ lists: listed });
    const r = await s.decide({ target: 100n * USDC, lists: listed });
    await s.worker.tick(T0);
    const call = s.writer.sent[0]?.call;
    expect(call).toMatchObject({ fn: "pin", counterparty: A });
    s.mineSent(0, [
      { name: "CounterpartyRegistered", args: { counterparty: A, limit: "0", recordHash: r.recordHash } },
      { name: "CounterpartyPinned", args: { counterparty: A, recordHash: r.recordHash } },
    ]);
    await s.worker.tick(at(1));
    expect(await s.store.receipts(s.scope)).toEqual([expect.objectContaining({ recordId: r.record.id, status: "confirmed", onchainLimitAfter: 0n })]);
    expect(await s.store.mirror(s.scope, A)).toMatchObject({ registered: true, pinned: true, limit: 0n, firstRegisteredBlock: 10n });
    expect(await s.externals()).toEqual([]);
    expect((await s.records.readChain(s.scope)).length).toBe(1);
  });

  test("tighten: LimitTightened confirms the rules-lane intent; mirror limit follows", async () => {
    const s = await setup();
    s.chain.views.set(A, registered(200n * USDC));
    const r = await s.decide({ target: 50n * USDC, view: registered(200n * USDC) });
    await s.worker.tick(T0);
    expect(s.writer.sent[0]?.call).toMatchObject({ fn: "tighten", limit: 50n * USDC });
    s.mineSent();
    await s.worker.tick(at(1));
    expect(await s.store.receipts(s.scope, r.record.id)).toEqual([expect.objectContaining({ status: "confirmed", onchainLimitAfter: 50n * USDC })]);
    expect(await s.store.mirror(s.scope, A)).toMatchObject({ limit: 50n * USDC, registered: false });
    expect(await s.store.monitoredSet(s.scope)).toEqual([]); // a tighten never registers
  });
});

describe("indexer: ExternalRecords", () => {
  test("Human setLimit (Registered + LimitSet, unknown hash): exactly one ExternalRecord, actor human, events in log order; mirror human-set", async () => {
    const s = await setup();
    const h = H("7");
    const tx = s.chain.mine(HUMAN, [
      { name: "CounterpartyRegistered", args: { counterparty: B, limit: "300", recordHash: h } },
      { name: "LimitSet", args: { counterparty: B, oldLimit: "0", newLimit: "300", humanEpoch: "1", recordHash: h } },
    ]);
    const report = await s.worker.tick(T0);
    expect(report.indexer?.wallets[0]).toMatchObject({ external: 1, alerts: 0 });
    const [ext, ...rest] = await s.externals();
    expect(rest).toEqual([]);
    expect(ext).toMatchObject({
      recordType: "external",
      actor: "human",
      actorAddress: HUMAN,
      txHash: tx,
      blockNumber: 10,
      blockTimestamp: toWireTime(new Date(Number(1_790_000_000n + 20n) * 1000)),
      carriedHash: h,
      counterparty: B,
      reason: "Observed on-chain; Horos did not originate or evaluate this change.",
      simulated: false,
      advisory: false,
    });
    expect(ext?.events.map((e) => [e.logIndex, e.name])).toEqual([
      [0, "CounterpartyRegistered"],
      [1, "LimitSet"],
    ]);
    expect(await s.store.mirror(s.scope, B)).toMatchObject({ registered: true, limit: 300n, humanSet: true, humanEpoch: 1n, firstRegisteredBlock: 10n });
    expect(s.notifier.alerts).toEqual([]);
  });

  test("replayed hash: a Human LimitSet carrying an existing record's hash (even of an in-flight intent) → ExternalRecord carrying it, no receipt", async () => {
    const s = await setup();
    s.chain.views.set(A, registered(200n * USDC));
    const r = await s.decide({ target: 50n * USDC, view: registered(200n * USDC) });
    await s.worker.tick(T0); // tighten in flight, carrying r's hash
    s.chain.mine(HUMAN, [{ name: "LimitSet", args: { counterparty: A, oldLimit: "200000000", newLimit: "900000000", humanEpoch: "1", recordHash: r.recordHash } }]);
    await s.worker.tick(at(1));
    const [ext] = await s.externals();
    expect(ext).toMatchObject({ actor: "human", carriedHash: r.recordHash, counterparty: A });
    expect(await s.store.receipts(s.scope)).toEqual([]);
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("pending");
  });

  test("a tx that looks like a Horos write but carries a hash no in-flight intent explains is external too (a Registered with a larger limit)", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.mineSent(0, [{ name: "CounterpartyRegistered", args: { counterparty: A, limit: "400000000", recordHash: r.recordHash } }]);
    await s.worker.tick(at(1));
    expect(await s.store.receipts(s.scope)).toEqual([]);
    expect((await s.externals())[0]).toMatchObject({ actor: "registrar", carriedHash: r.recordHash });
  });

  test("counterparty-less PolicyChanged → ExternalRecord without counterparty", async () => {
    const s = await setup();
    s.chain.mine(HUMAN, [{ name: "PolicyChanged", args: { field: "0", oldValue: "500000000", newValue: "250000000", recordHash: ZERO_BYTES32 } }]);
    await s.worker.tick(T0);
    const [ext] = await s.externals();
    expect(ext).toMatchObject({ actor: "human", carriedHash: ZERO_BYTES32 });
    expect(ext).not.toHaveProperty("counterparty");
  });

  test("OwnershipTransferred → actor pending-human; UnpinRequested → zero carriedHash and the mirror's request time", async () => {
    const s = await setup();
    const NEW_HUMAN: Hex = `0x${"8".repeat(40)}`;
    s.chain.mine(NEW_HUMAN, [{ name: "OwnershipTransferred", args: { from: HUMAN, to: NEW_HUMAN, recordHash: H("1") } }]);
    s.chain.mine(HUMAN, [{ name: "UnpinRequested", args: { counterparty: C, executableAt: "1790086422", reasonHash: H("2") } }]);
    await s.worker.tick(T0);
    const [own, unpin] = await s.externals();
    expect(own).toMatchObject({ actor: "pending-human", actorAddress: NEW_HUMAN, carriedHash: H("1") });
    expect(own).not.toHaveProperty("counterparty");
    expect(unpin).toMatchObject({ actor: "human", carriedHash: ZERO_BYTES32, counterparty: C });
    expect((await s.store.mirror(s.scope, C))?.unpinRequestedAt).toBe(1_790_000_000n + 11n * 2n);
  });

  test("unrecognised Registrar write (no intent) → ExternalRecord actor registrar + one founder alert", async () => {
    const s = await setup();
    const tx = s.chain.mine(KEYS.registrar.address, [{ name: "CounterpartyRegistered", args: { counterparty: C, limit: "50", recordHash: H("3") } }]);
    await s.worker.tick(T0);
    expect((await s.externals())[0]).toMatchObject({ actor: "registrar", actorAddress: KEYS.registrar.address, counterparty: C, carriedHash: H("3") });
    expect(s.notifier.alerts).toEqual([
      expect.objectContaining({ kind: "unrecognised-horos-write", scope: s.scope, policyWallet: WALLET, txHash: tx, actor: "registrar" }),
    ]);
    // Replaying the chunk neither appends again nor re-alerts.
    await s.store.setCursor(WALLET, s.scope, DEPLOY_BLOCK, T0);
    await s.worker.tick(at(1));
    expect(await s.externals()).toHaveLength(1);
    expect(s.notifier.alerts).toHaveLength(1);
  });

  test("a failed alert delivery is retried on the next tick (the job is durable)", async () => {
    const s = await setup();
    s.notifier.failNext = 1;
    const tx = s.chain.mine(KEYS.rules.address, [{ name: "CounterpartyPinned", args: { counterparty: C, recordHash: H("3") } }]);
    const r1 = await s.worker.tick(T0);
    expect(r1.indexer?.alertErrors).toEqual([{ txHash: tx, error: "webhook down" }]);
    expect(s.notifier.alerts).toEqual([]);
    const r2 = await s.worker.tick(at(1));
    expect(r2.indexer?.alertsDelivered).toEqual([tx]);
    expect(s.notifier.alerts).toEqual([expect.objectContaining({ kind: "unrecognised-horos-write", txHash: tx, actor: "rules" })]);
    await s.worker.tick(at(2));
    expect(s.notifier.alerts).toHaveLength(1);
  });

  test("a crash between the ExternalRecord append and the alert job still alerts exactly once on replay", async () => {
    const s = await setup();
    s.jobs.failEnsure = 1;
    const tx = s.chain.mine(KEYS.registrar.address, [{ name: "CounterpartyRegistered", args: { counterparty: C, limit: "50", recordHash: H("3") } }]);
    const r1 = await s.worker.tick(T0);
    expect(r1.indexer?.wallets[0]?.error).toMatch(/crash before the alert job/);
    expect(await s.externals()).toHaveLength(1); // appended before the crash
    expect(s.notifier.alerts).toEqual([]);
    await s.worker.tick(at(1)); // replay: the record exists, the alert job is ensured and delivered
    expect(s.notifier.alerts).toEqual([expect.objectContaining({ txHash: tx, actor: "registrar" })]);
    await s.store.setCursor(WALLET, s.scope, DEPLOY_BLOCK, at(2));
    await s.worker.tick(at(3)); // another replay
    expect(await s.externals()).toHaveLength(1);
    expect(s.notifier.alerts).toHaveLength(1);
  });

  test("a sender that held the role one block earlier (replaced in the same block) resolves via rolesAt(block − 1)", async () => {
    const s = await setup();
    const OLD_REGISTRAR: Hex = `0x${"6".repeat(40)}`;
    s.chain.rolesByBlock.set(s.chain.head - 1n, { ...s.chain.roleSet, registrar: OLD_REGISTRAR });
    s.chain.mine(OLD_REGISTRAR, [{ name: "CounterpartyRegistered", args: { counterparty: C, limit: "50", recordHash: H("3") } }]);
    const r = await s.worker.tick(T0);
    expect(r.indexer?.wallets[0]?.error).toBeUndefined();
    expect((await s.externals())[0]).toMatchObject({ actor: "registrar", actorAddress: OLD_REGISTRAR });
    expect(s.notifier.alerts).toHaveLength(1);
  });

  test("per-wallet isolation: the first wallet's logs() fails; the second wallet still advances and is indexed", async () => {
    const s = await setup();
    const PAY2: Hex = "0x0000000000000000000000000000000000000abc";
    const WALLET2: Hex = "0x0000000000000000000000000000000000000def";
    const { binding: b2 } = await s.accounts.onboard({ paymentAddress: PAY2, webhookUrl: "", now: at(1) });
    await s.accounts.setKeys(b2.customerId, KEYS, at(1));
    const bound2 = await s.accounts.bind(b2.customerId, WALLET2, at(1));
    s.chain.mine(HUMAN, [{ name: "PolicyChanged", args: { field: "0", oldValue: "1", newValue: "2", recordHash: ZERO_BYTES32 } }], undefined, WALLET2);
    s.chain.failWallets.add(WALLET);
    const r = await s.worker.tick(at(2));
    expect(r.indexer?.wallets.map((w) => [w.policyWallet, w.error])).toEqual([
      [WALLET, "rpc down"],
      [WALLET2, undefined],
    ]);
    expect(await s.store.cursor(WALLET)).toBe(DEPLOY_BLOCK);
    expect(await s.store.cursor(WALLET2)).toBe(s.chain.head);
    const ext = (await s.records.readChain(bound2.scopeId as Scope)).map((x) => x.record).filter(isExternalRecord);
    expect(ext).toEqual([expect.objectContaining({ policyWallet: WALLET2, actor: "human" })]);
  });

  test("an unknown sender on a role-gated event is an error: the chunk is retried, the cursor stays", async () => {
    const s = await setup();
    s.chain.mine(STRANGER, [{ name: "LimitTightened", args: { counterparty: A, oldLimit: "0", newLimit: "0", recordHash: H("4") } }]);
    const r1 = await s.worker.tick(T0);
    expect(r1.indexer?.wallets[0]?.error).toMatch(/holds no PolicyWallet role/);
    expect(await s.store.cursor(WALLET)).toBe(DEPLOY_BLOCK);
    expect(await s.externals()).toEqual([]);
    // The role turns out to be Model's (e.g. a mirror lag): the retry succeeds.
    s.chain.roleSet = { ...s.chain.roleSet, model: STRANGER };
    const r2 = await s.worker.tick(at(1));
    expect(r2.indexer?.wallets[0]?.error).toBeUndefined();
    expect((await s.externals())[0]).toMatchObject({ actor: "model" });
  });

  test("a Rules releasePin keeps the epoch; a Human executeUnpin bumps it", async () => {
    const s = await setup();
    s.chain.mine(KEYS.rules.address, [{ name: "CounterpartyPinned", args: { counterparty: A, recordHash: H("5") } }]);
    s.chain.mine(KEYS.rules.address, [{ name: "PinReleased", args: { counterparty: A, recordHash: H("6") } }]);
    s.chain.mine(KEYS.rules.address, [{ name: "CounterpartyPinned", args: { counterparty: A, recordHash: H("7") } }]);
    s.chain.mine(HUMAN, [{ name: "PinReleased", args: { counterparty: A, recordHash: H("8") } }]);
    await s.worker.tick(T0);
    expect((await s.externals()).map((e) => e.actor)).toEqual(["rules", "rules", "rules", "human"]);
    expect(await s.store.mirror(s.scope, A)).toMatchObject({ pinned: false, humanEpoch: 1n });
  });
});

describe("indexer: Paid, replay, cursor, reconciliation, Monitored set", () => {
  test("Paid → paid_event with matched_record_id (known hash, same counterparty) or null; never a record", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    s.chain.mine(PAY, [{ name: "Paid", args: { counterparty: A, amount: "5", recordHash: r.recordHash } }]);
    s.chain.mine(PAY, [{ name: "Paid", args: { counterparty: A, amount: "6", recordHash: H("e") } }]);
    await s.worker.tick(T0);
    const paid = await s.store.paidEvents(s.scope);
    expect(paid.map((p) => [p.amount, p.matchedRecordId])).toEqual([
      [5n, r.record.id],
      [6n, null],
    ]);
    expect(await s.externals()).toEqual([]);
    expect(await s.store.mirror(s.scope, A)).toBeUndefined();
  });

  test("replaying a chunk writes nothing new and leaves the mirror unchanged", async () => {
    const s = await setup();
    await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.mineSent();
    s.chain.mine(HUMAN, [{ name: "LimitSet", args: { counterparty: A, oldLimit: "100000000", newLimit: "300000000", humanEpoch: "1", recordHash: H("7") } }]);
    s.chain.mine(PAY, [{ name: "Paid", args: { counterparty: A, amount: "5", recordHash: H("e") } }]);
    await s.worker.tick(at(1));
    const snapshot = async () => ({
      receipts: await s.store.receipts(s.scope),
      paid: await s.store.paidEvents(s.scope),
      chain: await s.records.readChain(s.scope),
      mirror: await s.store.mirror(s.scope, A),
      outbox: await s.outbox.list(s.scope, A),
    });
    const before = await snapshot();
    expect(before.receipts).toHaveLength(1);
    expect(before.chain).toHaveLength(2);
    await s.store.setCursor(WALLET, s.scope, DEPLOY_BLOCK, at(2));
    const report = await s.worker.tick(at(3));
    expect(report.indexer?.wallets[0]?.error).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  test("deploy start: a new binding's cursor starts at the deploy block; ranges are chunked at most 2000 blocks up to latest − 1", async () => {
    const s = await setup();
    s.chain.deployBlock = 1234n;
    s.chain.head = 5000n;
    expect(await findDeployBlock(s.chain, WALLET, 5000n)).toBe(1234n);
    const report = await s.worker.tick(T0);
    expect(s.chain.logCalls).toEqual([
      [1234n, 3233n],
      [3234n, 4999n],
    ]);
    expect(report.indexer?.wallets[0]).toMatchObject({ chunks: 2, nextBlock: 5000n });
    expect(await s.store.cursor(WALLET)).toBe(5000n);
    s.chain.logCalls = [];
    await s.worker.tick(at(1));
    expect(s.chain.logCalls).toEqual([]); // nothing new below latest − confirmations
  });

  test("a failing logs read leaves the cursor and reports the error (other work in the tick still runs)", async () => {
    const s = await setup();
    s.chain.failLogs = true;
    const report = await s.worker.tick(T0);
    expect(report.indexer?.wallets[0]?.error).toBe("rpc down");
    expect(await s.store.cursor(WALLET)).toBe(DEPLOY_BLOCK);
    expect(report.indexer?.reconciled).toBe(0);
  });

  test("reconcile: noop → noop receipt; StaleEpoch → superseded_by_human; NewPayeeCapReached → failed_terminal", async () => {
    const s = await setup();
    s.chain.views.set(A, registered(100n * USDC));
    const rNoop = await s.decide({ target: 100n * USDC, view: registered(200n * USDC) });
    s.chain.views.set(B, registered(200n * USDC));
    const rStale = await s.decide({ target: 50n * USDC, counterparty: B, view: registered(200n * USDC) });
    const rCap = await s.decide({ target: 50n * USDC, counterparty: C });
    s.chain.simulateResult = { ok: false, revert: "StaleEpoch" };
    await s.worker.tick(T0); // A: noop; B: StaleEpoch (terminal); C: register → StaleEpoch too
    s.chain.simulateResult = { ok: true };
    const receipts = await s.store.receipts(s.scope);
    const status = (id: string) => receipts.filter((r) => r.recordId === id).map((r) => r.status);
    expect(status(rNoop.record.id)).toEqual(["noop"]);
    expect(status(rStale.record.id)).toEqual(["superseded_by_human"]);
    expect(status(rCap.record.id)).toEqual(["superseded_by_human"]);
    // A different terminal revert → failed_terminal.
    const D: Hex = "0x4444444444444444444444444444444444444444";
    const rFail = await s.decide({ target: 50n * USDC, counterparty: D, now: at(1) });
    s.chain.simulateResult = { ok: false, revert: "NewPayeeCapReached" };
    await s.worker.tick(at(2));
    expect((await s.store.receipts(s.scope, rFail.record.id)).map((r) => r.status)).toEqual(["failed_terminal"]);
  });

  test("Monitored set: registered via Registered and via a Human LimitSet; never-registered addresses are excluded", async () => {
    const s = await setup();
    s.chain.mine(KEYS.registrar.address, [{ name: "CounterpartyRegistered", args: { counterparty: B, limit: "10", recordHash: H("1") } }]);
    s.chain.mine(HUMAN, [
      { name: "CounterpartyRegistered", args: { counterparty: A, limit: "300", recordHash: H("2") } },
      { name: "LimitSet", args: { counterparty: A, oldLimit: "0", newLimit: "300", humanEpoch: "1", recordHash: H("2") } },
    ]);
    s.chain.mine(KEYS.rules.address, [{ name: "LimitTightened", args: { counterparty: C, oldLimit: "0", newLimit: "0", recordHash: H("3") } }]);
    await s.worker.tick(T0);
    expect(await s.store.monitoredSet(s.scope)).toEqual([A, B]);
  });
});
