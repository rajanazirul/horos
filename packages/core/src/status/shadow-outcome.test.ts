import { describe, expect, test } from "vitest";
import { shadowOutcome } from "./shadow-outcome.js";

const SHADOW = "shadow:01926f3a-7b2c-7d4e-8f00-0123456789ab";

describe("shadowOutcome", () => {
  test.each([
    ["allow", false, "advisory"],
    ["cap", false, "advisory"],
    ["hold", false, "would-have-caught"],
    ["block", false, "would-have-caught"],
    ["allow", true, "advisory"],
    ["cap", true, "advisory"],
    ["hold", true, "advisory"],
    ["block", true, "advisory"],
  ] as const)("%s simulated=%s -> %s", (decision, simulated, want) => {
    expect(shadowOutcome({ scope: SHADOW, decision, simulated })).toBe(want);
  });

  test("only two labels ever, and never 'gated' or 'caught' alone", () => {
    const seen = new Set<string>();
    for (const decision of ["allow", "cap", "hold", "block"] as const) {
      for (const simulated of [true, false]) seen.add(shadowOutcome({ scope: SHADOW, decision, simulated }));
    }
    expect([...seen].sort()).toEqual(["advisory", "would-have-caught"]);
  });

  test("non-shadow Scopes are refused", () => {
    expect(() => shadowOutcome({ scope: "advisory-public", decision: "block", simulated: false })).toThrow(RangeError);
    expect(() => shadowOutcome({ scope: "enforced:01926f3a-7b2c-7d4e-8f00-0123456789ab", decision: "hold", simulated: false })).toThrow(RangeError);
  });
});
