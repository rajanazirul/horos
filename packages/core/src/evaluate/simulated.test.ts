import { describe, expect, test } from "vitest";
import { evaluate } from "./evaluate.js";
import { baseInput, DEMO_ADDR, SDN_ADDR } from "./fixtures.test-helpers.js";
import { isSimulated } from "./simulated.js";

describe("isSimulated", () => {
  test("true when a Demo List Hard Rule matched", () => {
    const e = evaluate(baseInput({ counterparty: DEMO_ADDR }));
    expect(e.decision).toBe("block");
    expect(isSimulated(e)).toBe(true);
  });

  test("false for a real SDN match", () => {
    const e = evaluate(baseInput({ counterparty: SDN_ADDR }));
    expect(e.decision).toBe("block");
    expect(isSimulated(e)).toBe(false);
  });

  test("false when nothing matched, even with the Demo List loaded", () => {
    expect(isSimulated(evaluate(baseInput()))).toBe(false);
  });

  test("unmatched Demo List evidence never makes a Decision simulated", () => {
    const hardRules = [
      { rule: "exact-address-match", source: "horos-demo-list", snapshotId: "d", snapshotHash: `0x${"d".repeat(64)}`, matched: false },
      { rule: "exact-address-match", source: "ofac-sdn", snapshotId: "s", snapshotHash: `0x${"a".repeat(64)}`, matched: true },
    ] as const;
    expect(isSimulated({ hardRules })).toBe(false);
  });
});
