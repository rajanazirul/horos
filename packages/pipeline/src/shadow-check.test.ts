// Shadow Mode through the pipeline (Story 3.4): every matrix row reachable without HTTP. Real Postgres stores
// (virtual ledger included), the fake chain, a controllable clock.
import { decisionRecord, outboxIntent, usedNonce } from "@horos/adapters";
import { shadowOutcome, SIGNAL_IDS, STANDARD_PRESET, type ListSnapshot } from "@horos/core";
import { DecisionRecord, PolicyVersion, toWireTime, type Hex, type ShadowCheckRequest } from "@horos/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ledgerWindowPolicy, runCheck, runShadowCheck, type CheckDeps, type LedgerWindowPolicy, type ShadowCheckOutcome } from "./index.js";
import { harness, KEYS, loadTemplate, PAYEE, PAYEE_2, SDN_ADDR, sdnList, signedRequest, u, USDC, type Harness } from "./harness.test-helpers.js";

beforeAll(async () => {
  await loadTemplate();
}, 120_000);

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.client.close();
});

/** A Payment address that is not the template's bound Customer. */
const SHADOW_PAY: Hex = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const DEMO_ADDR: Hex = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const demoList = (lastVerifiedAt: number): ListSnapshot => ({
  source: "horos-demo-list",
  snapshotId: "demo-test",
  snapshotHash: `0x${"b".repeat(64)}`,
  entries: new Map([[DEMO_ADDR, ["HOROS DEMO ENTITY (TEST ONLY)"]]]),
  lastVerifiedAt,
});

async function setup() {
  const h = await harness();
  open.push(h);
  h.deps = { ...h.deps, lists: async () => [sdnList(h.clock.ms - 60_000), demoList(h.clock.ms - 60_000)] };
  const r = await h.shadow.signup(SHADOW_PAY, new Date(h.clock.ms));
  if (r.kind !== "issued") throw new Error("shadow sign-up failed");
  return { h, principal: { customerId: r.customerId, scope: r.scope }, apiKey: r.apiKey };
}

interface VirtualLedgerSpy {
  readonly calls: string[];
}

const req = (o: Partial<ShadowCheckRequest> = {}): ShadowCheckRequest => ({ counterparty: PAYEE, amount: u(50), ...o });

function decided(o: ShadowCheckOutcome) {
  if (o.kind !== "decided") throw new Error(`expected a decision, got ${o.kind}`);
  return o;
}

async function records(h: Harness, scope: string) {
  const rows = await h.db.select().from(decisionRecord).where(eq(decisionRecord.scope, scope));
  return rows.map((r) => DecisionRecord.parse(r.record));
}

describe("shadow Check", () => {
  test("first contact 50 USDC: allow, advisory, no chain write; virtual register + spend + one new payee", async () => {
    const { h, principal } = await setup();
    const o = decided(await runShadowCheck(req(), principal, h.deps));
    expect(o.scope).toBe(principal.scope);
    expect(o.response).toMatchObject({ decision: "allow", advisory: true, simulated: false, limit_write: "none", chain_state: "live" });
    expect(o.response.tx_hash).toBeUndefined();
    expect(o.response.questions).toBeUndefined();
    // Only `hasCode(a)` touched the chain: no remaining / policy / roles read.
    expect(h.chain.calls).toBe(1);
    // The record: in the shadow Scope, advisory, the Customer's, no PolicyWallet.
    const [rec] = await records(h, principal.scope);
    expect(rec).toMatchObject({ scope: principal.scope, customerId: principal.customerId, advisory: true, decision: "allow" });
    expect(rec?.policyWallet).toBeUndefined();
    // Nothing queued for the chain and no nonce consumed.
    expect(await h.db.$count(outboxIntent)).toBe(0);
    expect(await h.db.$count(usedNonce)).toBe(0);
    // Virtual effect: registered at the Target Limit, 50 spent in both rings, one new payee.
    const target = BigInt(o.response.effective_limit);
    expect(await h.shadow.remaining(principal.scope, PAYEE, new Date(h.clock.ms))).toMatchObject({
      registered: true,
      limit: target,
      cpRemaining: target - 50n * USDC,
      walletRemaining: 4_950n * USDC,
      newPayeeRemaining: 9n,
    });
  });

  test("spend accumulates: allow, allow, cap (payable = what is left), then cap at 0", async () => {
    const { h, principal } = await setup();
    const first = decided(await runShadowCheck(req({ amount: u(50) }), principal, h.deps));
    expect(first.response).toMatchObject({ decision: "allow", effective_limit: u(100) });
    const second = decided(await runShadowCheck(req({ amount: u(40) }), principal, h.deps));
    expect(second.response).toMatchObject({ decision: "allow", remaining: u(50) });
    const third = decided(await runShadowCheck(req({ amount: u(30) }), principal, h.deps));
    expect(third.response).toMatchObject({ decision: "cap", payable_amount: u(10), remaining: u(10) });
    const fourth = decided(await runShadowCheck(req({ amount: u(5) }), principal, h.deps));
    expect(fourth.response).toMatchObject({ decision: "cap", payable_amount: "0" });
    expect(await h.shadow.remaining(principal.scope, PAYEE, new Date(h.clock.ms))).toMatchObject({ cpRemaining: 0n, walletRemaining: 4_900n * USDC });
    // 31 days later the spend has left the window.
    h.clock.ms += 31 * 86_400_000;
    const later = decided(await runShadowCheck(req({ amount: u(60) }), principal, h.deps));
    expect(later.response).toMatchObject({ decision: "allow", remaining: u(100) });
  });

  test("the 11th new payee in the window holds (new-payee-cap)", async () => {
    const { h, principal } = await setup();
    for (let i = 0; i < 10; i++) {
      const a = `0x${"ab".repeat(19)}${i.toString(16).padStart(2, "0")}` as Hex;
      expect(decided(await runShadowCheck(req({ counterparty: a, amount: u(1) }), principal, h.deps)).response.decision).toBe("allow");
    }
    const eleventh = decided(await runShadowCheck(req({ counterparty: PAYEE_2, amount: u(1) }), principal, h.deps));
    expect(eleventh.response.decision).toBe("hold");
    expect(eleventh.evaluation.decisiveRule).toBe("new-payee-cap");
    // A hold spends nothing: the wallet still shows only the ten 1 USDC allows.
    expect(await h.shadow.remaining(principal.scope, PAYEE_2, new Date(h.clock.ms))).toMatchObject({ walletRemaining: 4_990n * USDC, cpRemaining: 0n });
  });

  test("a sanctioned counterparty blocks, is would-have-caught, and is pinned virtually", async () => {
    const { h, principal } = await setup();
    const o = decided(await runShadowCheck(req({ counterparty: SDN_ADDR }), principal, h.deps));
    expect(o.response).toMatchObject({ decision: "block", simulated: false, advisory: true, limit_write: "none" });
    // A block spends nothing.
    expect(await h.shadow.remaining(principal.scope, SDN_ADDR, new Date(h.clock.ms))).toMatchObject({ walletRemaining: 5_000n * USDC, cpRemaining: 0n });
    const [rec] = await records(h, principal.scope);
    expect(rec === undefined ? undefined : shadowOutcome(rec)).toBe("would-have-caught");
    expect(await h.shadow.remaining(principal.scope, SDN_ADDR, new Date(h.clock.ms))).toMatchObject({ pinned: true, registered: true, limit: 0n });
    expect(await h.shadow.summary(principal.scope)).toEqual({ advisory: 0, would_have_caught: 1 });
    expect(await h.db.$count(outboxIntent)).toBe(0);
  });

  test("a Horos Demo List hit blocks as simulated and counts as advisory", async () => {
    const { h, principal } = await setup();
    const o = decided(await runShadowCheck(req({ counterparty: DEMO_ADDR }), principal, h.deps));
    expect(o.response).toMatchObject({ decision: "block", simulated: true, advisory: true });
    const [rec] = await records(h, principal.scope);
    expect(rec === undefined ? undefined : shadowOutcome(rec)).toBe("advisory");
    expect(await h.shadow.summary(principal.scope)).toEqual({ advisory: 1, would_have_caught: 0 });
  });

  test("after the Customer's PolicyWallet is bound: shadow_closed, nothing written", async () => {
    const { h, principal } = await setup();
    decided(await runShadowCheck(req(), principal, h.deps));
    const accounts = new (await import("@horos/adapters")).PostgresAccountStore(h.db);
    const now = new Date(h.clock.ms);
    await accounts.onboard({ paymentAddress: SHADOW_PAY, webhookUrl: "", now });
    await accounts.setKeys(principal.customerId, KEYS, now);
    await accounts.bind(principal.customerId, "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", now);
    const callsBefore = h.chain.calls;
    expect(await runShadowCheck(req(), principal, h.deps)).toEqual({ kind: "shadow_closed" });
    expect(h.chain.calls).toBe(callsBefore);
    expect(await records(h, principal.scope)).toHaveLength(1);
  });

  test("rate limited: counted against the shadow principal, nothing read or written", async () => {
    const { h, principal } = await setup();
    const seen: unknown[] = [];
    const o = await runShadowCheck(req(), principal, h.deps, { admit: (p) => (seen.push(p), false) });
    expect(o).toEqual({ kind: "rate_limited", principal: { kind: "shadow", customerId: principal.customerId } });
    expect(seen).toEqual([{ kind: "shadow", customerId: principal.customerId }]);
    expect(h.chain.calls).toBe(0);
    expect(await records(h, principal.scope)).toHaveLength(0);
  });

  test("hasCode down: a first contact holds as a contract payee (conservative), stale", async () => {
    const { h, principal } = await setup();
    h.chain.primaryDown = true;
    h.chain.secondaryDown = true;
    const o = decided(await runShadowCheck(req(), principal, h.deps));
    expect(o.response).toMatchObject({ decision: "hold", chain_state: "stale", limit_write: "none" });
    expect(await h.shadow.remaining(principal.scope, PAYEE, new Date(h.clock.ms))).toMatchObject({ registered: false });
  });

  test("identity bindings and history are per shadow Scope", async () => {
    const { h, principal } = await setup();
    const identity = { name: "Acme Payments" };
    // The enforced Scope binds "Acme Payments" to PAYEE: the shadow Scope must not see it.
    await runCheck(await signedRequest({ counterparty: PAYEE, identity }), h.deps);
    const knownPayee = (o: ShadowCheckOutcome) => decided(o).evaluation.signals.find((sg) => sg.id === SIGNAL_IDS.knownPayeeNewAddress)?.value;
    expect(knownPayee(await runShadowCheck(req({ counterparty: PAYEE_2, declared_identity: identity }), principal, h.deps))).toBe(false);
    // Now bind it inside the shadow Scope (PAYEE_2 above did); a different address with the same name trips the signal.
    expect(knownPayee(await runShadowCheck(req({ counterparty: PAYEE, declared_identity: identity }), principal, h.deps))).toBe(true);
  });

  test("the no-history signal: true on first contact, false once the Counterparty is virtually registered", async () => {
    const { h, principal } = await setup();
    const noHistory = (o: ShadowCheckOutcome) => decided(o).evaluation.signals.find((sg) => sg.id === SIGNAL_IDS.noHistory)?.value;
    expect(noHistory(await runShadowCheck(req(), principal, h.deps))).toBe(true);
    expect(noHistory(await runShadowCheck(req({ amount: u(1) }), principal, h.deps))).toBe(false);
  });

  test("the binding flips to bound between the pre-check and the append: shadow_closed, nothing written", async () => {
    const { h, principal } = await setup();
    const accounts = new (await import("@horos/adapters")).PostgresAccountStore(h.db);
    const now = new Date(h.clock.ms);
    await accounts.onboard({ paymentAddress: SHADOW_PAY, webhookUrl: "", now });
    await accounts.setKeys(principal.customerId, KEYS, now);
    await accounts.bind(principal.customerId, "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", now);
    // The pre-check still says open (the race); the in-transaction re-check sees the bind.
    const ledger = h.shadow;
    const racing = {
      remaining: ledger.remaining.bind(ledger),
      hasHistory: ledger.hasHistory.bind(ledger),
      apply: ledger.apply.bind(ledger),
      isClosed: async () => false,
    };
    expect(await runShadowCheck(req(), principal, { ...h.deps, ledger: racing })).toEqual({ kind: "shadow_closed" });
    expect(await records(h, principal.scope)).toHaveLength(0);
    expect(await h.shadow.remaining(principal.scope, PAYEE, now)).toMatchObject({ registered: false, walletRemaining: 5_000n * USDC });
  });

  test("a concurrent pair of Checks whose allows together exceed the limit never overspends the ledger", async () => {
    const { h, principal } = await setup();
    decided(await runShadowCheck(req({ amount: u(10) }), principal, h.deps)); // registers at 100, 90 left
    const both = await Promise.all([runShadowCheck(req({ amount: u(60) }), principal, h.deps), runShadowCheck(req({ amount: u(60) }), principal, h.deps)]);
    expect(both.every((o) => o.kind === "decided")).toBe(true);
    // Whatever the interleaving, the virtual spend never passes the 100 USDC limit.
    const after = await h.shadow.remaining(principal.scope, PAYEE, new Date(h.clock.ms));
    expect(after.cpRemaining).toBe(0n);
    expect(after.walletRemaining).toBe(4_900n * USDC);
  });

  test("the ledger's window policy comes from the same active PolicyVersion as the evaluation (tightened)", async () => {
    const { h, principal } = await setup();
    decided(await runShadowCheck(req({ counterparty: PAYEE_2, amount: u(1) }), principal, h.deps));
    const active = await h.policies.active(principal.scope);
    if (active === undefined) throw new Error("no active policy");
    const tightened = PolicyVersion.parse({
      id: h.deps.newId(),
      scope: principal.scope,
      seq: active.seq + 1,
      parentId: active.id,
      presetVersion: active.presetVersion,
      activation: "tighter-proof",
      policy: { ...active.policy, tierCeilings: { low: u(40), elevated: u(20), high: "0", severe: "0" } },
      createdAt: toWireTime(new Date(h.clock.ms)),
    });
    await h.policies.insert(tightened);
    const seen: LedgerWindowPolicy[] = [];
    const ledger = h.shadow;
    const spy = {
      remaining: async (scope: string, a: Hex, now: Date, policy: LedgerWindowPolicy) => (seen.push(policy), ledger.remaining(scope, a, now, policy)),
      hasHistory: ledger.hasHistory.bind(ledger),
      apply: (scope: string, a: Hex, effect: Parameters<typeof ledger.apply>[2], now: Date, policy: LedgerWindowPolicy) => (seen.push(policy), ledger.apply(scope, a, effect, now, policy)),
      isClosed: ledger.isClosed.bind(ledger),
    };
    const o = decided(await runShadowCheck(req({ amount: u(50) }), principal, { ...h.deps, ledger: spy }));
    // The tightened off-chain ceiling decides (elevated tier on first contact: 20 USDC) ...
    expect(o.response).toMatchObject({ decision: "cap", effective_limit: u(20), payable_amount: u(20) });
    // ... and the ledger ran under that PolicyVersion's Preset window values, for both the read and the write.
    const want = ledgerWindowPolicy(tightened);
    expect(seen).toEqual([want, want]);
    expect(want).toEqual({
      firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling,
      walletPeriodCap: STANDARD_PRESET.onchain.walletPeriodCap,
      newPayeeCap: BigInt(STANDARD_PRESET.onchain.newPayeeCap),
      policyPeriodDays: BigInt(STANDARD_PRESET.onchain.policyPeriodDays),
    });
    expect(await h.shadow.remaining(principal.scope, PAYEE, new Date(h.clock.ms))).toMatchObject({ limit: 20n * USDC, cpRemaining: 0n });
    // An unknown Preset falls back to the Standard Preset's window values.
    expect(ledgerWindowPolicy({ presetVersion: "unknown@1" })).toEqual(want);
  });

  test("the principal must name its Customer's shadow Scope, and the ledger is required", async () => {
    const { h, principal } = await setup();
    await expect(runShadowCheck(req(), { ...principal, scope: "advisory-public" }, h.deps)).rejects.toThrow();
    const noLedger: CheckDeps<unknown> = { ...h.deps, ledger: undefined } as unknown as CheckDeps<unknown>;
    await expect(runShadowCheck(req(), principal, noLedger)).rejects.toThrow(/ledger/);
  });
});

describe("enforced isolation", () => {
  test("an enforced Check never calls the virtual ledger and leaves the ledger tables untouched", async () => {
    const { h, principal } = await setup();
    decided(await runShadowCheck(req(), principal, h.deps));
    const counts = async () => (await h.client.query<{ n: number }>(`SELECT (SELECT count(*) FROM shadow_ledger_counterparty) + (SELECT count(*) FROM shadow_ledger_slot) AS n`)).rows[0]?.n;
    const before = Number(await counts());
    const spy: VirtualLedgerSpy = { calls: [] };
    const trap = new Proxy(h.shadow, {
      get(target, prop, receiver) {
        spy.calls.push(String(prop));
        return Reflect.get(target, prop, receiver);
      },
    });
    const o = await runCheck(await signedRequest({ counterparty: PAYEE_2 }), { ...h.deps, ledger: trap });
    expect(o.kind === "decided" && o.response.advisory).toBe(false);
    expect(spy.calls).toEqual([]);
    expect(Number(await counts())).toBe(before);
  });
});
