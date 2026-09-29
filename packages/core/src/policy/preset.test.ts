import { OffchainPolicy } from "@horos/schema";
import { describe, expect, test } from "vitest";
import * as core from "../index.js";
import { PRESETS, STANDARD_PRESET, bpsToThreshold, findPreset, fromOffchainPolicy, thresholdToBps, toOffchainPolicy } from "./preset.js";

describe("STANDARD_PRESET", () => {
  test("carries exactly the standard@1 values", () => {
    expect(STANDARD_PRESET.version).toBe("standard@1");
    expect(STANDARD_PRESET.onchain).toEqual({
      firstContactCeiling: 500_000_000n,
      walletPeriodCap: 5_000_000_000n,
      newPayeeCap: 10,
      policyPeriodDays: 30,
    });
    expect(STANDARD_PRESET.offchain).toEqual({
      tierCeilings: { low: 500_000_000n, elevated: 100_000_000n, high: 0n, severe: 0n },
      autoDecideThresholdBps: 7000,
      missingIdentityThreshold: 100_000_000n,
      missingIdentityCeiling: 100_000_000n,
      questionSetVersion: "v1",
      judge: "jev-1.13.0",
      noHistoryTier: "elevated",
    });
  });

  test("schema form is the decimal-string wire form", () => {
    const wire = toOffchainPolicy(STANDARD_PRESET.offchain);
    expect(wire).toEqual({
      tierCeilings: { low: "500000000", elevated: "100000000", high: "0", severe: "0" },
      autoDecideThreshold: "0.7000",
      missingIdentityThreshold: "100000000",
      missingIdentityCeiling: "100000000",
      questionSetVersion: "v1",
      judge: "jev-1.13.0",
      noHistoryTier: "elevated",
    });
    expect(OffchainPolicy.parse(wire)).toEqual(wire);
    expect(fromOffchainPolicy(wire)).toEqual(STANDARD_PRESET.offchain);
  });

  test("is frozen and registered", () => {
    expect(Object.isFrozen(STANDARD_PRESET)).toBe(true);
    expect(Object.isFrozen(STANDARD_PRESET.offchain.tierCeilings)).toBe(true);
    expect(PRESETS["standard@1"]).toBe(STANDARD_PRESET);
    expect(findPreset("standard@1")).toBe(STANDARD_PRESET);
    expect(findPreset("conservative@1")).toBeUndefined();
    expect(findPreset("toString")).toBeUndefined();
  });

  test("the barrel exports the public surface", () => {
    expect(core.PACKAGE_NAME).toBe("@horos/core");
    for (const name of ["STANDARD_PRESET", "isTighterOrEqual", "looserDimensions", "decideActivation", "SeqConflictError", "TIER_ORDER"]) {
      expect(core).toHaveProperty(name);
    }
  });
});

describe("threshold basis points", () => {
  test.each([
    ["0.0000", 0],
    ["0.0001", 1],
    ["0.7000", 7000],
    ["0.9999", 9999],
    ["1.0000", 10000],
  ])("%s <-> %d", (s, bps) => {
    expect(thresholdToBps(s)).toBe(bps);
    expect(bpsToThreshold(bps)).toBe(s);
  });

  test.each(["0.7", "1.0001", "", "0.70000"])("rejects %j", (s) => {
    expect(() => thresholdToBps(s)).toThrow(RangeError);
  });

  test.each([-1, 10001, 0.5, Number.NaN])("rejects bps %d", (bps) => {
    expect(() => bpsToThreshold(bps)).toThrow(RangeError);
  });
});
