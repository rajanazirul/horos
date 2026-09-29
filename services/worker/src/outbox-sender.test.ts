import type { PGlite } from "@electric-sql/pglite";
import {
  deterministicUuid,
  outboxExtraWrites,
  PostgresAccountStore,
  PostgresJobStore,
  PostgresListStore,
  PostgresOutboxStore,
  PostgresRecordStore,
  upsertIntent,
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
  type KeyProvisioner,
  type ListSnapshot,
  type LivePolicy,
  type Notifier,
  type PolicyWalletCall,
  type PolicyWalletLog,
  type ProvisionedKeys,
  type SimulateResult,
  type WalletRoles,
  type WriteRequest,
  type WriteStatus,
} from "@horos/core";
import { DecisionRecord, recordHash, toWireTime, type Hex, type Scope } from "@horos/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migratedClient, migratedDump } from "./migrated-db.test-helpers.js";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createWorker } from "./tick.js";

const USDC = 1_000_000n;
const PAY: Hex = "0x705f7d75b1689c42034ca5102700be481edca2da";
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const A: Hex = "0x1111111111111111111111111111111111111111";
const T0 = new Date("2026-09-28T12:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-registrar", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-model", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-rules", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};

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

class FakeReader implements ChainReader {
  views = new Map<string, ChainView>();
  fcc = 500n * USDC;
  simulateResult: SimulateResult = { ok: true };
  simulated: { call: PolicyWalletCall; from: Hex }[] = [];
  async remaining(_w: Hex, a: Hex) {
    return this.views.get(a) ?? unregistered;
  }
  async roles(): Promise<WalletRoles> {
    return { payment: PAY, registrar: KEYS.registrar.address, model: KEYS.model.address, rules: KEYS.rules.address, human: `0x${"9".repeat(40)}` };
  }
  async policy(): Promise<LivePolicy> {
    return { firstContactCeiling: this.fcc, walletPeriodCap: 5_000n * USDC, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n };
  }
  async hasCode() {
    return false;
  }
  async simulate(_w: Hex, call: PolicyWalletCall, from: Hex) {
    this.simulated.push({ call, from });
    return this.simulateResult;
  }
  // Indexer reads (unused here: this suite runs no indexer).
  async latestBlock(): Promise<bigint> {
    throw new Error("not used");
  }
  async logs(): Promise<PolicyWalletLog[]> {
    throw new Error("not used");
  }
  async blockTimestamp(): Promise<bigint> {
    throw new Error("not used");
  }
  async txFrom(): Promise<Hex> {
    throw new Error("not used");
  }
  async rolesAt(): Promise<WalletRoles> {
    return this.roles();
  }
  async hasCodeAt(): Promise<boolean> {
    return false;
  }
}

class FakeWriter implements ChainWriter {
  sent: WriteRequest[] = [];
  failSends = 0;
  failMessage = "circle 503";
  beforeSend: (() => Promise<void>) | undefined;
  statusResult: WriteStatus = { state: "pending" };
  async send(req: WriteRequest) {
    await this.beforeSend?.();
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error(this.failMessage);
    }
    this.sent.push(req);
    return { txId: `tx-${this.sent.length}` };
  }
  async status() {
    return this.statusResult;
  }
}

class RecordingNotifier implements Notifier {
  readonly alerts: FounderAlert[] = [];
  async notify(alert: FounderAlert) {
    this.alerts.push(alert);
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

async function setup(opts: { lists?: ListSnapshot[] } = {}) {
  const client = await migratedClient();
  clients.push(client);
  const db = drizzle(client);
  const accounts = new PostgresAccountStore(db);
  const records = new PostgresRecordStore(db);
  const outbox = new PostgresOutboxStore(db);
  const jobs = new PostgresJobStore(db);
  const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T0 });
  await accounts.setKeys(binding.customerId, KEYS, T0);
  const bound = await accounts.bind(binding.customerId, WALLET, T0);
  const scope = bound.scopeId as Scope;
  const reader = new FakeReader();
  const writer = new FakeWriter();
  const notifier = new RecordingNotifier();
  let lists = opts.lists ?? [sdn()];
  const worker = createWorker({
    jobs,
    lists: new PostgresListStore(db),
    fetchSdn: noFetch,
    notifier,
    newId: () => uuidv7(),
    outbox: { accounts, outbox, records, reader, writer, notifier, loadLists: async () => lists, newId: uuidv7 },
  });

  /** Pipeline fixture: core `evaluate` + `buildDecisionRecord`, appended with `outboxExtraWrites`. */
  async function decide(p: { target: bigint; view?: ChainView; lists?: ListSnapshot[]; now?: Date }) {
    const view = p.view ?? unregistered;
    const now = p.now ?? T0;
    const e: Evaluation = evaluate({
      counterparty: A,
      amount: 1n * USDC,
      declaredIdentity: { name: "Acme Data, Inc." },
      now: now.getTime(),
      lists: p.lists ?? [sdn()],
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
            counterparty: A,
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

  return {
    db,
    client,
    scope,
    binding: bound,
    accounts,
    records,
    outbox,
    reader,
    writer,
    notifier,
    worker,
    decide,
    setLists: (l: ListSnapshot[]) => {
      lists = l;
    },
  };
}

describe("outbox sender", () => {
  test("coalesce race + one register: exactly register(a, 100, hash of the 100 record)", async () => {
    const s = await setup();
    const [r500, r100] = await Promise.all([s.decide({ target: 500n * USDC }), s.decide({ target: 100n * USDC })]);
    const first = r500.record.seq < r100.record.seq ? r500 : r100;
    const second = first === r500 ? r100 : r500;
    await s.worker.tick(T0);
    await s.worker.tick(at(1));
    expect(s.writer.sent).toHaveLength(1);
    expect(s.writer.sent[0]).toMatchObject({
      policyWallet: WALLET,
      call: { fn: "register", counterparty: A, limit: 100n * USDC, recordHash: r100.recordHash },
      signer: { address: KEYS.registrar.address, circleWalletId: "w-registrar" },
    });
    expect(s.reader.simulated[0]?.from).toBe(KEYS.registrar.address);
    const [intent] = await s.outbox.list(s.scope, A);
    expect(intent).toMatchObject({ status: "submitted", circleTxId: "tx-1" });
    expect(new Set(intent?.recordIds)).toEqual(new Set([r500.record.id, r100.record.id]));
    expect(await s.outbox.intentState(s.scope, A, first.record.id)).toBe("pending");
    expect(await s.outbox.intentState(s.scope, A, second.record.id)).toBe("coalesced");
  });

  test("COMPLETE stores the tx hash and stays submitted; nothing is ever confirmed here", async () => {
    const s = await setup();
    await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.writer.statusResult = { state: "complete", txHash: `0x${"e".repeat(64)}` };
    const r = await s.worker.tick(at(1));
    expect(r.outbox?.polled).toEqual([expect.objectContaining({ kind: "tx-hash" })]);
    const [intent] = await s.outbox.list(s.scope, A);
    expect(intent).toMatchObject({ status: "submitted", txHash: `0x${"e".repeat(64)}` });
  });

  test("in-flight: a new decision opens a new pending row, not sent until the write in flight is mined", async () => {
    const s = await setup();
    await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.reader.views.set(A, registered(100n * USDC));
    await s.decide({ target: 40n * USDC, view: registered(100n * USDC), now: at(1) });
    await s.worker.tick(at(2));
    expect(s.writer.sent).toHaveLength(1);
    const rows = await s.outbox.list(s.scope, A);
    expect(rows.map((r) => [r.status, r.laneRole])).toEqual([
      ["submitted", "registrar"],
      ["pending", "rules"],
    ]);
    s.writer.statusResult = { state: "complete", txHash: `0x${"e".repeat(64)}` };
    await s.worker.tick(at(3));
    expect(s.writer.sent.map((w) => w.call.fn)).toEqual(["register", "tighten"]);
  });

  test("in-flight on the same lane: sent only once the first write has its tx hash", async () => {
    const s = await setup();
    await upsertIntent(s.db, intentRow(s.scope, { target: 10n, recordId: RID(1) }), uuidv7(T0.getTime()));
    await s.worker.tick(T0);
    await upsertIntent(s.db, intentRow(s.scope, { target: 5n, recordId: RID(2), counterparty: B }), uuidv7(T0.getTime()));
    await s.worker.tick(at(1));
    expect(s.writer.sent).toHaveLength(1);
    s.writer.statusResult = { state: "complete", txHash: `0x${"e".repeat(64)}` };
    await s.worker.tick(at(2));
    expect(s.writer.sent.map((r) => r.call.counterparty)).toEqual([A, B]);
  });

  test("FCC clamp: unregistered, target 900, live FCC 500 → register(a, 500)", async () => {
    const s = await setup();
    await upsertIntent(s.db, intentRow(s.scope, { target: 900n * USDC, recordId: RID(1) }), uuidv7(T0.getTime()));
    await s.worker.tick(T0);
    expect(s.writer.sent[0]?.call).toMatchObject({ fn: "register", limit: 500n * USDC });
  });

  test("noop: registered limit 100, target 100 → noop, no send, state none", async () => {
    const s = await setup();
    s.reader.views.set(A, registered(100n * USDC));
    const r = await s.decide({ target: 100n * USDC, view: registered(200n * USDC) });
    await s.worker.tick(T0);
    expect(s.writer.sent).toHaveLength(0);
    expect((await s.outbox.list(s.scope, A))[0]?.status).toBe("noop");
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("none");
  });

  test("tighten carries the decision-time epoch and is signed by Rules", async () => {
    const s = await setup();
    s.reader.views.set(A, registered(200n * USDC, 3n));
    await s.decide({ target: 50n * USDC, view: registered(200n * USDC, 3n) });
    await s.worker.tick(T0);
    expect(s.writer.sent[0]).toMatchObject({
      call: { fn: "tighten", limit: 50n * USDC, expectedEpoch: 3n },
      signer: { address: KEYS.rules.address, circleWalletId: "w-rules" },
    });
  });

  test("send-time SDN match: correcting block record + pin intent; register never sent", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    s.setLists([sdn([[A, ["EXAMPLE SANCTIONED ENTITY"]]])]);
    s.reader.simulateResult = { ok: false, revert: "AlreadyRegistered" }; // hold the follow-up pin back this tick
    const report = await s.worker.tick(T0);
    expect(report.outbox?.processed.map((p) => p.kind)).toEqual(["hard-rule", "retry"]);
    expect(s.writer.sent).toHaveLength(0);
    s.reader.simulateResult = { ok: true };
    const chain = await s.records.readChain(s.scope);
    expect(chain).toHaveLength(2);
    const block = DecisionRecord.parse(chain[1]?.record);
    expect(block).toMatchObject({ decision: "block", riskTier: "severe", trigger: "check", counterparty: A });
    expect(block?.hardRules.some((h) => h.matched)).toBe(true);
    expect(block).not.toHaveProperty("targetLimit");
    const intents = await s.outbox.list(s.scope, A);
    expect(intents.map((i) => [i.status, i.pin]).sort()).toEqual([
      ["failed", false],
      ["pending", true],
    ]);
    const pinIntent = intents.find((i) => i.pin);
    expect(pinIntent).toMatchObject({ createdByRecord: block?.id, sendRecordHash: chain[1]?.recordHash, laneRole: "rules" });
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("failed");
    await s.worker.tick(at(60));
    expect(s.writer.sent.map((w) => w.call)).toEqual([{ fn: "pin", counterparty: A, recordHash: chain[1]?.recordHash }]);
  });

  test.each(["NewPayeeCapReached", "StaleEpoch"])("terminal revert %s: failed + one correcting hold record, no retry", async (revert) => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    s.reader.simulateResult = { ok: false, revert };
    await s.worker.tick(T0);
    await s.worker.tick(at(3600));
    expect(s.writer.sent).toHaveLength(0);
    const chain = await s.records.readChain(s.scope);
    expect(chain).toHaveLength(2);
    expect(chain[1]?.record).toMatchObject({ decision: "hold", seq: 1, prevHash: r.recordHash, counterparty: A });
    expect(chain[1]?.record.reason).toContain(`(${revert})`);
    expect(recordHash(chain[1]?.record)).toBe(chain[1]?.recordHash);
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("failed");
  });

  test("a retryable revert (AlreadyRegistered) goes back to pending", async () => {
    const s = await setup();
    await s.decide({ target: 100n * USDC });
    s.reader.simulateResult = { ok: false, revert: "AlreadyRegistered" };
    await s.worker.tick(T0);
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(await s.records.readChain(s.scope)).toHaveLength(1);
  });

  test("Circle DENIED after submission: terminal", async () => {
    const s = await setup();
    const r = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    s.writer.statusResult = { state: "denied", error: "DENIED" };
    await s.worker.tick(at(1));
    const chain = await s.records.readChain(s.scope);
    expect(chain.map((c) => DecisionRecord.parse(c.record).decision)).toEqual([DecisionRecord.parse(r.record).decision, "hold"]);
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("failed");
  });

  test("retryable x3 (writer throws, then Circle FAILED): backoff, one alert at attempt 3, keeps retrying", async () => {
    const s = await setup();
    await s.decide({ target: 100n * USDC });
    s.writer.failSends = 2;
    await s.worker.tick(T0);
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: at(30) });
    await s.worker.tick(at(10));
    expect((await s.outbox.list(s.scope, A))[0]?.attempts).toBe(1);
    await s.worker.tick(at(30));
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ attempts: 2, nextAttemptAt: at(90) });
    expect(s.notifier.alerts).toHaveLength(0);
    await s.worker.tick(at(90));
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "submitted" });
    s.writer.statusResult = { state: "failed", error: "FAILED" };
    await s.worker.tick(at(91));
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "pending", attempts: 3, alerted: true, nextAttemptAt: at(91 + 120) });
    expect(s.notifier.alerts).toEqual([expect.objectContaining({ kind: "outbox-retry-exhausted", scope: s.scope, counterparty: A })]);
    s.writer.failSends = 1;
    await s.worker.tick(at(300));
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "pending", attempts: 4 });
    expect(s.notifier.alerts).toHaveLength(1);
    expect(await s.records.readChain(s.scope)).toHaveLength(1);
  });
});

describe("outbox sender: review fixes", () => {
  test("submitted + newer pending row, then Circle FAILED: merged into one pending row holding both record sets", async () => {
    const s = await setup();
    const r1 = await s.decide({ target: 100n * USDC });
    await s.worker.tick(T0);
    const r2 = await s.decide({ target: 60n * USDC, now: at(1) });
    s.writer.statusResult = { state: "failed", error: "FAILED" };
    const report = await s.worker.tick(at(2));
    expect(report.outbox?.polled).toEqual([expect.objectContaining({ kind: "retry" })]);
    // The merged row is due at once, so the same pass claims and sends it.
    expect(report.outbox?.processed).toEqual([expect.objectContaining({ kind: "submitted", fn: "register" })]);
    const rows = await s.outbox.list(s.scope, A);
    expect(rows.map((r) => r.status).sort()).toEqual(["noop", "submitted"]);
    const live = rows.find((r) => r.status === "submitted");
    expect(new Set(live?.recordIds)).toEqual(new Set([r1.record.id, r2.record.id]));
    expect(live).toMatchObject({ target: 60n * USDC, sendRecordHash: r2.recordHash });
    expect(s.writer.sent.map((w) => w.call)).toEqual([
      expect.objectContaining({ fn: "register", limit: 100n * USDC }),
      expect.objectContaining({ fn: "register", limit: 60n * USDC, recordHash: r2.recordHash }),
    ]);
    expect(await s.outbox.intentState(s.scope, A, r1.record.id)).toBe("coalesced");
  });

  test("writer throws while a newer decision arrived: merged, no unique violation, pass continues", async () => {
    const s = await setup();
    const r1 = await s.decide({ target: 100n * USDC });
    let r2: Awaited<ReturnType<typeof s.decide>> | undefined;
    s.writer.failSends = 1;
    s.writer.beforeSend = async () => {
      s.writer.beforeSend = undefined;
      r2 = await s.decide({ target: 40n * USDC, now: at(1) });
    };
    const report = await s.worker.tick(at(2));
    expect(report.outbox?.processed.map((p) => p.kind)).toEqual(["retry", "submitted"]);
    const rows = await s.outbox.list(s.scope, A);
    expect(rows.map((r) => r.status).sort()).toEqual(["noop", "submitted"]);
    const live = rows.find((r) => r.status === "submitted");
    expect(new Set(live?.recordIds)).toEqual(new Set([r1.record.id, r2?.record.id]));
    expect(live?.target).toBe(40n * USDC);
    expect(s.writer.sent.map((w) => ("limit" in w.call ? w.call.limit : undefined))).toEqual([40n * USDC]);
  });

  test("pin intent from an SDN block record, Circle DENIED: one correcting block record, intent failed", async () => {
    const listed = [sdn([[A, ["EXAMPLE SANCTIONED ENTITY"]]])];
    const s = await setup({ lists: listed });
    const r = await s.decide({ target: 100n * USDC, lists: listed });
    expect(DecisionRecord.parse(r.record).decision).toBe("block");
    await s.worker.tick(T0);
    expect(s.writer.sent[0]?.call).toEqual({ fn: "pin", counterparty: A, recordHash: r.recordHash });
    s.writer.statusResult = { state: "denied", error: "DENIED" };
    await s.worker.tick(at(1));
    const chain = await s.records.readChain(s.scope);
    expect(chain.map((c) => DecisionRecord.parse(c.record).decision)).toEqual(["block", "block"]);
    expect(chain[1]?.record.reason).toContain("(CircleDenied)");
    expect(await s.outbox.intentState(s.scope, A, r.record.id)).toBe("failed");
  });

  test.each([
    ["stale", [sdn()].map((l) => ({ ...l, lastVerifiedAt: T0.getTime() - 25 * 3600 * 1000 }))],
    ["missing", []],
  ])("send-time SDN list %s: retry with 'sanctions list stale', never register", async (_label, lists) => {
    const s = await setup();
    await s.decide({ target: 100n * USDC });
    s.setLists(lists);
    const report = await s.worker.tick(T0);
    expect(report.outbox?.processed).toEqual([expect.objectContaining({ kind: "retry", error: "sanctions list stale" })]);
    expect(s.writer.sent).toHaveLength(0);
    expect((await s.outbox.list(s.scope, A))[0]).toMatchObject({ status: "pending", lastError: "sanctions list stale" });
  });

  test("RPC URLs in errors are reduced to their origin before they are stored or alerted", async () => {
    const s = await setup();
    await s.decide({ target: 100n * USDC });
    s.writer.failSends = 1;
    s.writer.failMessage = "HTTP request failed. URL: https://rpc.example.com/v2/SECRETKEY?x=1";
    await s.worker.tick(T0);
    const row = (await s.outbox.list(s.scope, A))[0];
    expect(row?.lastError).toBe("send failed: HTTP request failed. URL: https://rpc.example.com");
  });

  test("the idempotency key is seeded with intent id, attempts, target, pin and send_record_hash", async () => {
    const s = await setup();
    await upsertIntent(s.db, intentRow(s.scope, { target: 10n, recordId: RID(1) }), uuidv7(T0.getTime()));
    await s.worker.tick(T0);
    const [row] = await s.outbox.list(s.scope, A);
    expect(s.writer.sent[0]?.idempotencyKey).toBe(
      deterministicUuid(`horos:outbox:${row?.id}:0:10:false:${"0x" + "1".repeat(64)}`),
    );
  });
});

describe("provisioning job", () => {
  test("onboard → tick provisions keys once; a failing provisioner is retried next tick", async () => {
    const client = await migratedClient();
    clients.push(client);
    const db = drizzle(client);
    const accounts = new PostgresAccountStore(db);
    const jobs = new PostgresJobStore(db);
    let fail = 1;
    let calls = 0;
    const provisioner: KeyProvisioner = {
      async provision() {
        calls++;
        if (fail-- > 0) throw new Error("circle 500");
        return KEYS;
      },
    };
    const worker = createWorker({
      jobs,
      lists: new PostgresListStore(db),
      fetchSdn: noFetch,
      notifier: new RecordingNotifier(),
      newId: () => uuidv7(),
      provisioning: { accounts, provisioner },
    });
    const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T0 });
    const r1 = await worker.tick(T0);
    expect(r1.provision?.failed).toEqual([{ customerId: binding.customerId, error: "circle 500" }]);
    const r2 = await worker.tick(at(1));
    expect(r2.provision?.provisioned).toEqual([binding.customerId]);
    expect((await accounts.bindingByPayment(PAY))?.keys).toEqual(KEYS);
    await worker.tick(at(2));
    expect(calls).toBe(2);
  });
});

const B: Hex = "0x2222222222222222222222222222222222222222";
const RID = (n: number) => `01926f3a-8000-7000-8000-${String(n).padStart(12, "0")}`;
function intentRow(scope: string, p: { target: bigint; recordId: string; counterparty?: Hex }) {
  return {
    scope,
    counterparty: p.counterparty ?? A,
    laneRole: "registrar" as const,
    target: p.target,
    pin: false,
    humanEpoch: 0n,
    recordId: p.recordId,
    recordHash: `0x${"1".repeat(64)}` as Hex,
    now: T0,
  };
}
