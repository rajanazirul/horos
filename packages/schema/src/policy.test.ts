import { describe, expect, test } from "vitest";
import { CreatePolicyVersionRequest, OffchainPolicy, PolicyVersion } from "./policy.js";

const policy = {
  tierCeilings: { low: "500000000", elevated: "100000000", high: "0", severe: "0" },
  autoDecideThreshold: "0.7000",
  missingIdentityThreshold: "100000000",
  missingIdentityCeiling: "100000000",
  questionSetVersion: "v1",
  judge: "jev-1.13.0",
  noHistoryTier: "elevated",
};
const scope = "enforced:01926f3a-7b2c-7d4e-8f00-0123456789ab";

describe("OffchainPolicy", () => {
  test("accepts the standard values", () => {
    expect(OffchainPolicy.parse(policy)).toEqual(policy);
  });

  test.each(["0.7", "0.70000", "1.0001", "1", "-0.1000", "0.7e0"])("rejects threshold %s", (t) => {
    expect(OffchainPolicy.safeParse({ ...policy, autoDecideThreshold: t }).success).toBe(false);
  });

  test("rejects float money, unknown keys and unknown tiers", () => {
    expect(OffchainPolicy.safeParse({ ...policy, missingIdentityCeiling: "1.5" }).success).toBe(false);
    expect(OffchainPolicy.safeParse({ ...policy, extra: 1 }).success).toBe(false);
    expect(OffchainPolicy.safeParse({ ...policy, noHistoryTier: "medium" }).success).toBe(false);
    expect(OffchainPolicy.safeParse({ ...policy, tierCeilings: { ...policy.tierCeilings, x: "0" } }).success).toBe(false);
  });
});

describe("CreatePolicyVersionRequest", () => {
  test("accepts a preset request", () => {
    expect(CreatePolicyVersionRequest.parse({ scope, presetVersion: "standard@1", policy }).presetVersion).toBe("standard@1");
  });

  test("rejects a smuggled signature as an unknown key", () => {
    const r = CreatePolicyVersionRequest.safeParse({ scope, presetVersion: "standard@1", policy, human_signature: "0x00" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  test.each(["standard", "Standard@1", "standard@0", ""])("rejects preset version %j", (v) => {
    expect(CreatePolicyVersionRequest.safeParse({ scope, presetVersion: v, policy }).success).toBe(false);
  });

  test("rejects an invalid scope", () => {
    expect(CreatePolicyVersionRequest.safeParse({ scope: "enforced:x", presetVersion: "standard@1", policy }).success).toBe(false);
  });
});

describe("PolicyVersion", () => {
  const row = {
    id: "01926f3a-7b2c-7d4e-8f00-0123456789ac",
    scope,
    seq: 1,
    presetVersion: "standard@1",
    activation: "preset",
    policy,
    createdAt: "2026-09-26T00:00:00.000Z",
  };

  test("accepts a first version without parentId", () => {
    expect(PolicyVersion.parse(row)).toEqual(row);
  });

  test("rejects seq 0, null parentId and an unknown activation", () => {
    expect(PolicyVersion.safeParse({ ...row, seq: 0 }).success).toBe(false);
    expect(PolicyVersion.safeParse({ ...row, parentId: null }).success).toBe(false);
    expect(PolicyVersion.safeParse({ ...row, activation: "human" }).success).toBe(false);
  });
});
