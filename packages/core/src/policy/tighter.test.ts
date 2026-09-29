import type { RiskTier } from "@horos/schema";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { STANDARD_PRESET, type CoreOffchainPolicy } from "./preset.js";
import { TIER_ORDER, isTighterOrEqual, looserDimensions, tierRank } from "./tighter.js";

const S = STANDARD_PRESET.offchain;
const with_ = (patch: Partial<CoreOffchainPolicy>): CoreOffchainPolicy => ({ ...S, ...patch });
const ceilings = (patch: Partial<CoreOffchainPolicy["tierCeilings"]>): CoreOffchainPolicy =>
  with_({ tierCeilings: { ...S.tierCeilings, ...patch } });

describe("isTighterOrEqual (worked examples)", () => {
  test("equal is tighter-or-equal", () => {
    expect(isTighterOrEqual(S, { ...S, tierCeilings: { ...S.tierCeilings } })).toBe(true);
  });

  test.each([
    ["lower elevated ceiling", ceilings({ elevated: 50_000_000n })],
    ["lower low ceiling", ceilings({ low: 0n })],
    ["higher threshold", with_({ autoDecideThresholdBps: 7001 })],
    ["lower missing-identity threshold", with_({ missingIdentityThreshold: 1n })],
    ["lower missing-identity ceiling", with_({ missingIdentityCeiling: 0n })],
    ["more severe no-history tier", with_({ noHistoryTier: "high" })],
  ])("tighter: %s", (_name, next) => {
    expect(looserDimensions(S, next)).toEqual([]);
    expect(isTighterOrEqual(S, next)).toBe(true);
  });

  test.each([
    ["raise low ceiling to 600", ceilings({ low: 600_000_000n }), "tierCeilings.low"],
    ["raise high ceiling", ceilings({ high: 1n }), "tierCeilings.high"],
    ["raise severe ceiling", ceilings({ severe: 1n }), "tierCeilings.severe"],
    ["raise elevated ceiling", ceilings({ elevated: 100_000_001n }), "tierCeilings.elevated"],
    ["threshold to 0.6", with_({ autoDecideThresholdBps: 6000 }), "autoDecideThreshold"],
    ["raise missing-identity threshold", with_({ missingIdentityThreshold: 100_000_001n }), "missingIdentityThreshold"],
    ["raise missing-identity ceiling", with_({ missingIdentityCeiling: 100_000_001n }), "missingIdentityCeiling"],
    ["less severe no-history tier", with_({ noHistoryTier: "low" }), "noHistoryTier"],
    ["judge swap", with_({ judge: "jev-1.14.0" }), "judge"],
    ["question-set swap", with_({ questionSetVersion: "v2" }), "questionSetVersion"],
  ])("looser: %s", (_name, next, dim) => {
    expect(looserDimensions(S, next)).toEqual([dim]);
    expect(isTighterOrEqual(S, next)).toBe(false);
  });

  test("a judge swap is rejected even alongside tightening", () => {
    const next = with_({ judge: "other", tierCeilings: { low: 0n, elevated: 0n, high: 0n, severe: 0n } });
    expect(looserDimensions(S, next)).toEqual(["judge"]);
  });

  test("reports every looser dimension", () => {
    const next = with_({ autoDecideThresholdBps: 0, noHistoryTier: "low", tierCeilings: { ...S.tierCeilings, low: 10n ** 12n } });
    expect(looserDimensions(S, next)).toEqual(["tierCeilings.low", "autoDecideThreshold", "noHistoryTier"]);
  });

  test("tier order", () => {
    expect(TIER_ORDER).toEqual(["low", "elevated", "high", "severe"]);
    expect(TIER_ORDER.map(tierRank)).toEqual([0, 1, 2, 3]);
    expect(() => tierRank("medium" as RiskTier)).toThrow(RangeError);
  });
});

// ---- properties ----

const MAX_MONEY = 10n ** 15n;
const money = fc.bigInt({ min: 0n, max: MAX_MONEY });
const tier = fc.constantFrom<RiskTier>(...TIER_ORDER);
const label = fc.constantFrom("v1", "v2", "jev-1.13.0", "jev-2.0.0");

const policy: fc.Arbitrary<CoreOffchainPolicy> = fc.record({
  tierCeilings: fc.record({ low: money, elevated: money, high: money, severe: money }),
  autoDecideThresholdBps: fc.integer({ min: 0, max: 10_000 }),
  missingIdentityThreshold: money,
  missingIdentityCeiling: money,
  questionSetVersion: label,
  judge: label,
  noHistoryTier: tier,
});

type Dim =
  | "tierCeilings.low"
  | "tierCeilings.elevated"
  | "tierCeilings.high"
  | "tierCeilings.severe"
  | "autoDecideThreshold"
  | "missingIdentityThreshold"
  | "missingIdentityCeiling"
  | "noHistoryTier";
const DIMS: readonly Dim[] = [
  "tierCeilings.low",
  "tierCeilings.elevated",
  "tierCeilings.high",
  "tierCeilings.severe",
  "autoDecideThreshold",
  "missingIdentityThreshold",
  "missingIdentityCeiling",
  "noHistoryTier",
];

/**
 * Move one dimension by `step` (≥ 0) in the tighter direction (`dir = 1`) or looser (`dir = -1`),
 * clamped to its domain. `frac` in [0, 1] picks how far.
 */
function move(p: CoreOffchainPolicy, dim: Dim, dir: 1 | -1, frac: number): CoreOffchainPolicy {
  const moveMoney = (v: bigint): bigint => {
    // Tighter = lower.
    if (dir === 1) return v - (v * BigInt(Math.round(frac * 1000))) / 1000n;
    return v + 1n + BigInt(Math.round(frac * 1000)) * 1000n;
  };
  switch (dim) {
    case "tierCeilings.low":
    case "tierCeilings.elevated":
    case "tierCeilings.high":
    case "tierCeilings.severe": {
      const t = dim.slice("tierCeilings.".length) as keyof CoreOffchainPolicy["tierCeilings"];
      return { ...p, tierCeilings: { ...p.tierCeilings, [t]: moveMoney(p.tierCeilings[t]) } };
    }
    case "missingIdentityThreshold":
      return { ...p, missingIdentityThreshold: moveMoney(p.missingIdentityThreshold) };
    case "missingIdentityCeiling":
      return { ...p, missingIdentityCeiling: moveMoney(p.missingIdentityCeiling) };
    case "autoDecideThreshold": {
      // Tighter = higher.
      const cur = p.autoDecideThresholdBps;
      if (dir === 1) return { ...p, autoDecideThresholdBps: cur + Math.round(frac * (10_000 - cur)) };
      return { ...p, autoDecideThresholdBps: cur - 1 - Math.round(frac * (cur - 1 < 0 ? 0 : cur - 1)) };
    }
    case "noHistoryTier": {
      // Tighter = more severe.
      const r = tierRank(p.noHistoryTier);
      const nr = dir === 1 ? r + Math.round(frac * (3 - r)) : r - 1 - Math.round(frac * Math.max(r - 1, 0));
      return { ...p, noHistoryTier: TIER_ORDER[nr] ?? p.noHistoryTier };
    }
  }
}

/** Can dimension `dim` of `p` be loosened within its domain? */
function canLoosen(p: CoreOffchainPolicy, dim: Dim): boolean {
  if (dim === "autoDecideThreshold") return p.autoDecideThresholdBps > 0;
  if (dim === "noHistoryTier") return p.noHistoryTier !== "low";
  return true;
}

const dim = fc.constantFrom(...DIMS);
const frac = fc.double({ min: 0, max: 1, noNaN: true });

describe("isTighterOrEqual (properties)", () => {
  test("reflexive", () => {
    fc.assert(fc.property(policy, (p) => isTighterOrEqual(p, { ...p, tierCeilings: { ...p.tierCeilings } })));
  });

  test("tightening any single dimension keeps it true", () => {
    fc.assert(fc.property(policy, dim, frac, (p, d, f) => isTighterOrEqual(p, move(p, d, 1, f))));
  });

  test("loosening any single dimension makes it false and names that dimension", () => {
    fc.assert(
      fc.property(policy, dim, frac, (p, d, f) => {
        fc.pre(canLoosen(p, d));
        const next = move(p, d, -1, f);
        expect(looserDimensions(p, next)).toEqual([d]);
        expect(isTighterOrEqual(p, next)).toBe(false);
      }),
    );
  });

  test("transitive over generated tightening chains", () => {
    const steps = fc.array(fc.tuple(dim, frac), { minLength: 1, maxLength: 12 });
    fc.assert(
      fc.property(policy, steps, (p, ss) => {
        const chain = [p];
        for (const [d, f] of ss) chain.push(move(chain[chain.length - 1] ?? p, d, 1, f));
        for (let i = 0; i < chain.length; i++) {
          for (let j = i; j < chain.length; j++) {
            expect(isTighterOrEqual(chain[i] as CoreOffchainPolicy, chain[j] as CoreOffchainPolicy)).toBe(true);
          }
        }
      }),
    );
  });

  test("transitive over derived triples", () => {
    // b is derived from a, and c from b, by tightening moves; the premise always holds.
    const step = fc.tuple(dim, frac);
    const steps = fc.array(step, { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(policy, steps, steps, (a, s1, s2) => {
        const b = s1.reduce((p, [d, f]) => move(p, d, 1, f), a);
        const c = s2.reduce((p, [d, f]) => move(p, d, 1, f), b);
        expect(isTighterOrEqual(a, b)).toBe(true);
        expect(isTighterOrEqual(b, c)).toBe(true);
        expect(isTighterOrEqual(a, c)).toBe(true);
      }),
    );
  });

  test("any judge or question-set change is false, whatever else changes", () => {
    fc.assert(
      fc.property(policy, policy, fc.constantFrom("judge", "questionSetVersion"), (p, q, which) => {
        const next = { ...q, [which]: `${p[which]}-x` };
        expect(isTighterOrEqual(p, next)).toBe(false);
        expect(looserDimensions(p, next)).toContain(which);
      }),
    );
  });
});
