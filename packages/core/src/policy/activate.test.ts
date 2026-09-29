import type { CreatePolicyVersionRequest, OffchainPolicy } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { decideActivation } from "./activate.js";
import { STANDARD_PRESET, toOffchainPolicy } from "./preset.js";

const scope = "enforced:01926f3a-7b2c-7d4e-8f00-0123456789ab";
const standard = toOffchainPolicy(STANDARD_PRESET.offchain);
const req = (policy: OffchainPolicy, presetVersion = "standard@1"): CreatePolicyVersionRequest => ({ scope, presetVersion, policy });
const active = { id: "01926f3a-7b2c-7d4e-8f00-0123456789ac", seq: 1, presetVersion: "standard@1", policy: standard };

describe("decideActivation", () => {
  test("first version equal to the Preset activates as preset seq 1", () => {
    expect(decideActivation(undefined, req(standard))).toEqual({ ok: true, activation: "preset", seq: 1 });
  });

  test("first version that differs from the Preset is rejected, even if tighter", () => {
    const tighter = { ...standard, tierCeilings: { ...standard.tierCeilings, elevated: "50000000" } };
    const d = decideActivation(undefined, req(tighter));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("exact copy of preset standard@1");
  });

  test("first version naming an unknown Preset is rejected", () => {
    const d = decideActivation(undefined, req(standard, "permissive@1"));
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toContain("unknown preset");
  });

  test("tighter change activates as tighter-proof with parent", () => {
    const next = { ...standard, tierCeilings: { ...standard.tierCeilings, elevated: "50000000" } };
    expect(decideActivation(active, req(next))).toEqual({ ok: true, activation: "tighter-proof", seq: 2, parentId: active.id });
  });

  test("equal change activates", () => {
    expect(decideActivation({ ...active, seq: 7 }, req(standard))).toMatchObject({ ok: true, seq: 8 });
  });

  test.each([
    [{ ...standard, tierCeilings: { ...standard.tierCeilings, low: "600000000" } }, "tierCeilings.low"],
    [{ ...standard, autoDecideThreshold: "0.6000" }, "autoDecideThreshold"],
    [{ ...standard, judge: "jev-2.0.0" }, "judge"],
    [{ ...standard, questionSetVersion: "v2" }, "questionSetVersion"],
  ])("looser or swapped change is rejected naming %s", (next, dim) => {
    const d = decideActivation(active, req(next));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain(dim);
  });

  test("a later version must keep the active Preset lineage", () => {
    const d = decideActivation(active, req(standard, "standard@2"));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("presetVersion standard@2 does not match the active version's standard@1");
  });
});
