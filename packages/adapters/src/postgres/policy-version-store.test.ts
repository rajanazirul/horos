import { SeqConflictError, STANDARD_PRESET, toOffchainPolicy } from "@horos/core";
import type { PolicyVersion } from "@horos/schema";
import { afterEach, describe, expect, test } from "vitest";
import { PostgresPolicyVersionStore, pgErrorCode, pgErrorConstraint } from "./policy-version-store.js";
import { freshDb, type TestClient } from "./test-db.js";

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});
async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return { ...r, store: new PostgresPolicyVersionStore(r.db) };
}

const scope = "enforced:01926f3a-7b2c-7d4e-8f00-0123456789ab";
const policy = toOffchainPolicy(STANDARD_PRESET.offchain);
const v1: PolicyVersion = {
  id: "01926f3a-7b2c-7d4e-8f00-000000000001",
  scope,
  seq: 1,
  presetVersion: "standard@1",
  activation: "preset",
  policy,
  createdAt: "2026-09-26T10:00:00.123Z",
};
const v2: PolicyVersion = {
  ...v1,
  id: "01926f3a-7b2c-7d4e-8f00-000000000002",
  seq: 2,
  parentId: v1.id,
  activation: "tighter-proof",
  policy: { ...policy, tierCeilings: { ...policy.tierCeilings, elevated: "50000000" } },
  createdAt: "2026-09-26T10:00:01.000Z",
};

describe("PostgresPolicyVersionStore", () => {
  test("active is undefined for an empty scope", async () => {
    const { store } = await setup();
    expect(await store.active(scope)).toBeUndefined();
  });

  test("round-trips and returns the highest seq as active", async () => {
    const { store } = await setup();
    await store.insert(v1);
    expect(await store.active(scope)).toEqual(v1);
    await store.insert(v2);
    expect(await store.active(scope)).toEqual(v2);
    expect(await store.active("advisory-public")).toBeUndefined();
  });

  test("a (scope, seq) collision raises SeqConflictError", async () => {
    const { store } = await setup();
    await store.insert(v1);
    const dup = { ...v1, id: "01926f3a-7b2c-7d4e-8f00-000000000009" };
    const err = await store.insert(dup).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeqConflictError);
    expect(err).toMatchObject({ scope, seq: 1 });
  });

  test("a duplicate id (primary-key 23505) is not a SeqConflictError", async () => {
    const { store } = await setup();
    await store.insert(v1);
    const err = await store.insert({ ...v2, id: v1.id }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SeqConflictError);
    expect(pgErrorCode(err)).toBe("23505");
    expect(pgErrorConstraint(err)).toBe("policy_version_pkey");
  });

  test("other database errors pass through unchanged", async () => {
    const { store } = await setup();
    const orphan = { ...v2, parentId: "01926f3a-7b2c-7d4e-8f00-00000000dead" };
    const err = await store.insert(orphan).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SeqConflictError);
    expect(pgErrorCode(err)).toBe("23503");
  });

  test("insert validates the row", async () => {
    const { store } = await setup();
    await expect(store.insert({ ...v1, seq: 0 })).rejects.toThrow();
  });
});

describe("pgErrorCode", () => {
  test("walks the cause chain", () => {
    expect(pgErrorCode({ cause: { code: "23505" } })).toBe("23505");
    expect(pgErrorCode(new Error("x"))).toBeUndefined();
    expect(pgErrorCode({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorConstraint({ cause: { code: "23505", constraint: "c" } })).toBe("c");
    expect(pgErrorConstraint({ code: "23505" })).toBeUndefined();
  });
});
