import type { ChainReader, LivePolicy, WalletRoles } from "@horos/core";
import type { Hex } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { cachedChainReader } from "./cached-reader.js";

const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const OTHER: Hex = "0x1111111111111111111111111111111111111111";
const ROLES: WalletRoles = { payment: WALLET, registrar: WALLET, model: WALLET, rules: WALLET, human: WALLET };
const POLICY: LivePolicy = { firstContactCeiling: 1n, walletPeriodCap: 2n, newPayeeCap: 3n, policyPeriodDays: 30n, unpinDelay: 4n };
const VIEW = { cpRemaining: 1n, walletRemaining: 2n, newPayeeRemaining: 3n, limit: 4n, pinned: false, registered: true, humanSet: false, humanEpoch: 0n };

function counting(fail: { roles?: number } = {}) {
  const n = { roles: 0, policy: 0, remaining: 0, hasCode: 0 };
  const reader = {
    roles: async () => {
      n.roles++;
      if (n.roles <= (fail.roles ?? 0)) throw new Error("rpc down");
      return ROLES;
    },
    policy: async () => {
      n.policy++;
      return POLICY;
    },
    remaining: async () => {
      n.remaining++;
      return VIEW;
    },
    hasCode: async () => {
      n.hasCode++;
      return true;
    },
  } as unknown as ChainReader;
  return { reader, n };
}

describe("cachedChainReader", () => {
  test("roles and policy are read once per wallet within the TTL, and again after it", async () => {
    let t = 0;
    const { reader, n } = counting();
    const r = cachedChainReader(reader, { ttlMs: 5000, now: () => t });
    expect(await r.roles(WALLET)).toEqual(ROLES);
    expect(await r.policy(WALLET)).toEqual(POLICY);
    t = 4999;
    await r.roles(WALLET);
    await r.policy(WALLET.toUpperCase().replace("0X", "0x") as Hex);
    expect([n.roles, n.policy]).toEqual([1, 1]);
    await r.roles(OTHER);
    expect(n.roles).toBe(2);
    t = 5000;
    await r.roles(WALLET);
    await r.policy(WALLET);
    expect([n.roles, n.policy]).toEqual([3, 2]);
  });

  test("concurrent reads share one request", async () => {
    const { reader, n } = counting();
    const r = cachedChainReader(reader, { ttlMs: 5000, now: () => 0 });
    await Promise.all([r.roles(WALLET), r.roles(WALLET), r.roles(WALLET)]);
    expect(n.roles).toBe(1);
  });

  test("a failed read is not cached", async () => {
    const { reader, n } = counting({ roles: 1 });
    const r = cachedChainReader(reader, { ttlMs: 5000, now: () => 0 });
    await expect(r.roles(WALLET)).rejects.toThrow("rpc down");
    expect(await r.roles(WALLET)).toEqual(ROLES);
    await r.roles(WALLET);
    expect(n.roles).toBe(2);
  });

  test("remaining and hasCode are never cached", async () => {
    const { reader, n } = counting();
    const r = cachedChainReader(reader, { ttlMs: 5000, now: () => 0 });
    await r.remaining(WALLET, OTHER);
    await r.remaining(WALLET, OTHER);
    await r.hasCode(WALLET);
    await r.hasCode(WALLET);
    expect([n.remaining, n.hasCode]).toEqual([2, 2]);
  });

  test("ttlMs 0 disables the cache", async () => {
    const { reader } = counting();
    expect(cachedChainReader(reader, { ttlMs: 0 })).toBe(reader);
  });
});
