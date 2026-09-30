// The rolling-window port against the Foundry-generated vectors (Story 1.3 `remaining-window.json`, Story 3.4
// `remaining-composition.json`). The wallet cases replay the exact PolicyWallet steps through a small TS model whose
// only arithmetic is the port under test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DayIndexOverflowError,
  dayIndexAt,
  dayIndexOf,
  MAX_WINDOW_DAYS,
  record,
  recordSlot,
  remainingView,
  RING_SIZE,
  satSub,
  UINT224_MAX,
  UNKNOWN_COUNTERPARTY,
  windowSum,
  type CounterpartyWindowState,
  type Ring,
  type Slot,
  type WindowPolicy,
} from "./rolling-window.js";

const VECTORS = fileURLToPath(new URL("../../../../contracts/test-vectors/", import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${VECTORS}${name}`, "utf8")) as T;

interface JsonSlot {
  readonly dayIndex: number;
  readonly amount: string;
}

/** `RingHarness.setSlot`: write at the canonical index, later writes to the same index win. */
function ringOf(slots: readonly JsonSlot[]): Ring {
  const m = new Map<number, Slot>();
  for (const s of slots) m.set(s.dayIndex % RING_SIZE, { dayIndex: s.dayIndex, amount: BigInt(s.amount) });
  return m;
}

describe("remaining-window.json (Story 1.3)", () => {
  const file = load<{
    ringSize: number;
    cases: { name: string; timestamp: number; periodDays: number; cap: string; slots: JsonSlot[]; windowSum: string; remaining: string }[];
  }>("remaining-window.json");

  test("ring size", () => {
    expect(file.ringSize).toBe(RING_SIZE);
    expect(file.cases.length).toBeGreaterThanOrEqual(12);
  });

  test.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const ring = ringOf(c.slots);
    const today = dayIndexOf(BigInt(c.timestamp));
    const sum = windowSum(ring, today, c.periodDays);
    expect(sum.toString()).toBe(c.windowSum);
    expect(satSub(BigInt(c.cap), sum).toString()).toBe(c.remaining);
  });
});

interface CompositionFile {
  readonly ringSize: number;
  readonly recordCases: readonly {
    readonly name: string;
    readonly initialSlots: readonly JsonSlot[];
    readonly records: readonly { readonly today: number; readonly amount: string }[];
    readonly slots: readonly (JsonSlot & { readonly index: number })[];
    readonly sumToday: number;
    readonly sumPeriodDays: number;
    readonly windowSum: string;
  }[];
  readonly windowCases: readonly { readonly name: string; readonly slots: readonly JsonSlot[]; readonly today: number; readonly periodDays: string; readonly windowSum: string }[];
  readonly walletCases: readonly WalletCase[];
}

interface JsonRemaining {
  readonly counterparty: string;
  readonly cpRemaining: string;
  readonly walletRemaining: string;
  readonly newPayeeRemaining: string;
  readonly limit: string;
  readonly pinned: boolean;
  readonly registered: boolean;
  readonly humanSet: boolean;
  readonly humanEpoch: string;
}

interface WalletCase {
  readonly name: string;
  readonly timestamp: number;
  readonly policy: Record<keyof WindowPolicy, string>;
  readonly counterparties: readonly string[];
  readonly initial: readonly JsonRemaining[];
  readonly steps: readonly { readonly op: string; readonly counterparty: string | null; readonly value: string | null; readonly remaining: readonly JsonRemaining[] }[];
}

/** A minimal PolicyWallet state machine over the port (register / pay / tighten / pin / setLimit / Policy setters). */
class WalletModel {
  ts: bigint;
  policy: WindowPolicy;
  cps = new Map<string, CounterpartyWindowState>();
  cpRings = new Map<string, Ring>();
  wallet: Ring = new Map();
  newPayees: Ring = new Map();

  constructor(c: WalletCase) {
    this.ts = BigInt(c.timestamp);
    this.policy = {
      firstContactCeiling: BigInt(c.policy.firstContactCeiling),
      walletPeriodCap: BigInt(c.policy.walletPeriodCap),
      newPayeeCap: BigInt(c.policy.newPayeeCap),
      policyPeriodDays: BigInt(c.policy.policyPeriodDays),
    };
  }

  get today(): bigint {
    return dayIndexOf(this.ts);
  }

  cp(a: string): CounterpartyWindowState {
    return this.cps.get(a) ?? UNKNOWN_COUNTERPARTY;
  }

  view(a: string) {
    return remainingView(this.cp(a), { counterparty: this.cpRings.get(a) ?? new Map(), wallet: this.wallet, newPayees: this.newPayees }, this.policy, this.today);
  }

  apply(op: string, a: string | null, raw: string | null): void {
    const v = raw === null ? 0n : BigInt(raw);
    const cp = a === null ? UNKNOWN_COUNTERPARTY : this.cp(a);
    const set = (next: Partial<CounterpartyWindowState>) => this.cps.set(a ?? "", { ...cp, ...next });
    switch (op) {
      case "warp":
        this.ts = v;
        return;
      case "register":
        set({ registered: true, limit: v });
        if (v > 0n) this.newPayees = record(this.newPayees, this.today, 1n);
        return;
      case "pay":
        this.cpRings.set(a ?? "", record(this.cpRings.get(a ?? "") ?? new Map(), this.today, v));
        this.wallet = record(this.wallet, this.today, v);
        return;
      case "tighten":
        set({ limit: v < cp.limit ? v : cp.limit });
        return;
      case "setLimit":
        set({ registered: true, limit: v, humanSet: true, humanEpoch: cp.humanEpoch + 1n });
        return;
      case "pin":
        set({ registered: true, limit: 0n, pinned: true });
        return;
      case "setPolicyPeriod":
        this.policy = { ...this.policy, policyPeriodDays: v };
        return;
      case "setFirstContactCeiling":
        this.policy = { ...this.policy, firstContactCeiling: v };
        return;
      case "setWalletPeriodCap":
        this.policy = { ...this.policy, walletPeriodCap: v };
        return;
      case "setNewPayeeCap":
        this.policy = { ...this.policy, newPayeeCap: v };
        return;
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
}

function asJson(a: string, v: ReturnType<WalletModel["view"]>): JsonRemaining {
  return {
    counterparty: a,
    cpRemaining: v.cpRemaining.toString(),
    walletRemaining: v.walletRemaining.toString(),
    newPayeeRemaining: v.newPayeeRemaining.toString(),
    limit: v.limit.toString(),
    pinned: v.pinned,
    registered: v.registered,
    humanSet: v.humanSet,
    humanEpoch: v.humanEpoch.toString(),
  };
}

describe("remaining-composition.json (Story 3.4)", () => {
  const file = load<CompositionFile>("remaining-composition.json");

  test("ring size and coverage", () => {
    expect(file.ringSize).toBe(RING_SIZE);
    expect(file.recordCases.length).toBeGreaterThanOrEqual(8);
    expect(file.windowCases.every((c) => BigInt(c.periodDays) > BigInt(MAX_WINDOW_DAYS))).toBe(true);
    const ops = new Set(file.walletCases.flatMap((c) => c.steps.map((s) => s.op)));
    for (const op of ["warp", "register", "pay", "tighten", "setLimit", "pin"]) expect(ops).toContain(op);
  });

  test.each(file.recordCases.map((c) => [c.name, c] as const))("record: %s", (_name, c) => {
    let ring = ringOf(c.initialSlots);
    for (const r of c.records) ring = record(ring, r.today, BigInt(r.amount));
    const got = [...ring.entries()]
      .filter(([, s]) => !(s.dayIndex === 0 && s.amount === 0n))
      .sort(([a], [b]) => a - b)
      .map(([index, s]) => ({ index, dayIndex: s.dayIndex, amount: s.amount.toString() }));
    expect(got).toEqual(c.slots);
    expect(windowSum(ring, c.sumToday, c.sumPeriodDays).toString()).toBe(c.windowSum);
  });

  test.each(file.windowCases.map((c) => [c.name, c] as const))("window clamp: %s", (_name, c) => {
    expect(windowSum(ringOf(c.slots), c.today, BigInt(c.periodDays)).toString()).toBe(c.windowSum);
  });

  test.each(file.walletCases.map((c) => [c.name, c] as const))("wallet: %s", (_name, c) => {
    const w = new WalletModel(c);
    expect(c.counterparties.map((a) => asJson(a, w.view(a)))).toEqual(c.initial);
    c.steps.forEach((s, i) => {
      w.apply(s.op, s.counterparty, s.value);
      expect(c.counterparties.map((a) => asJson(a, w.view(a))), `${c.name} step ${i} (${s.op})`).toEqual(s.remaining);
    });
  });
});

describe("port edge cases", () => {
  test("record refuses a day index beyond uint32 and negative input", () => {
    expect(() => record(new Map(), 2n ** 32n, 1n)).toThrow(DayIndexOverflowError);
    expect(() => record(new Map(), -1, 1n)).toThrow(RangeError);
    expect(() => record(new Map(), 1, -1n)).toThrow(RangeError);
  });

  test("record does not mutate its input; recordSlot names the canonical index", () => {
    const ring: Ring = new Map();
    const next = record(ring, 20_721, 5n);
    expect(ring.size).toBe(0);
    expect(recordSlot(next, 20_721, UINT224_MAX)).toEqual([20_721 % RING_SIZE, { dayIndex: 20_721, amount: UINT224_MAX }]);
  });

  test("day index of a Date rounds down to whole days", () => {
    expect(dayIndexAt(new Date("2026-09-25T23:59:59.999Z"))).toBe(20_721);
    expect(dayIndexAt(new Date("2026-09-26T00:00:00.000Z"))).toBe(20_722);
  });

  test("satSub saturates at zero", () => {
    expect(satSub(5n, 7n)).toBe(0n);
    expect(satSub(7n, 5n)).toBe(2n);
  });
});
