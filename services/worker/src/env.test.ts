import { describeEnvFailure } from "@horos/adapters";
import { describe, expect, test } from "vitest";
import { parseMigrateEnv, parseWorkerEnv } from "./env.js";

// Well-known Foundry/Anvil dev keys. Test-only; never funded on any real network.
const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const K2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const K3 = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const KEYS = JSON.stringify({ registrar: K1, model: K2, rules: K3 });

const BASE = {
  DATABASE_URL: "postgres://horos_worker:not-a-real-password@db.internal:5432/railway",
  CHAIN_ID: "5042002",
  ARC_RPC_PRIMARY: "https://rpc.primary.example",
  ARC_RPC_SECONDARY: "https://rpc.secondary.example",
  FOUNDER_ALERT_WEBHOOK_URL: "https://hooks.example.com/services/T0/B0/not-a-real-token",
} as const;
const CIRCLE = { ...BASE, CHAIN_WRITER: "circle", CIRCLE_API_KEY: "TEST_API_KEY:aaa:bbb", CIRCLE_ENTITY_SECRET: "test-entity-secret-value" } as const;

function failure(raw: Record<string, string | undefined>): string {
  const r = parseWorkerEnv(raw);
  if (r.ok) throw new Error("expected an invalid environment");
  return describeEnvFailure("horos-worker", r.invalid);
}

describe("worker env", () => {
  test("circle: parses with defaults; the secrets live only inside chainWriter", () => {
    const r = parseWorkerEnv(CIRCLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.chainWriter).toEqual({ kind: "circle", apiKey: CIRCLE.CIRCLE_API_KEY, entitySecret: CIRCLE.CIRCLE_ENTITY_SECRET });
    expect(r.env.TICK_INTERVAL_MS).toBe(5000);
    expect(r.env.OFAC_SDN_URL).toMatch(/^https:\/\/sanctionslistservice\.ofac\.treas\.gov\//);
    expect(Object.keys(r.env)).not.toContain("CIRCLE_API_KEY");
    expect(Object.keys(r.env)).not.toContain("CIRCLE_ENTITY_SECRET");
  });

  test("CHAIN_WRITER=circle without CIRCLE_ENTITY_SECRET: named, no values", () => {
    const line = failure({ ...CIRCLE, CIRCLE_ENTITY_SECRET: undefined });
    expect(line).toBe("horos-worker: invalid environment: CIRCLE_ENTITY_SECRET (required when CHAIN_WRITER=circle)");
    expect(line).not.toContain("TEST_API_KEY");
  });

  test("local on chain 31337: parses exactly the registrar, model and rules keys", () => {
    const r = parseWorkerEnv({ ...BASE, CHAIN_ID: "31337", CHAIN_WRITER: "local", LOCAL_SIGNER_KEYS: KEYS });
    expect(r.ok && r.env.chainWriter).toEqual({ kind: "local", keys: { registrar: K1, model: K2, rules: K3 } });
  });

  test("local on any other chain needs ALLOW_LOCAL_WRITER=1", () => {
    expect(failure({ ...BASE, CHAIN_WRITER: "local", LOCAL_SIGNER_KEYS: KEYS })).toContain("CHAIN_WRITER (local needs CHAIN_ID=31337 or ALLOW_LOCAL_WRITER=1)");
    expect(parseWorkerEnv({ ...BASE, CHAIN_WRITER: "local", LOCAL_SIGNER_KEYS: KEYS, ALLOW_LOCAL_WRITER: "1" }).ok).toBe(true);
  });

  test.each([
    ["a subset", { registrar: K1, rules: K2 }],
    ["a payment key", { registrar: K1, model: K2, rules: K3, payment: K1 }],
    ["an unknown role", { registrar: K1, model: K2, rules: K3, owner: K1 }],
    ["a malformed key", { registrar: K1, model: K2, rules: "0x1234" }],
  ])("LOCAL_SIGNER_KEYS with %s is refused", (_label, keys) => {
    const line = failure({ ...BASE, CHAIN_ID: "31337", CHAIN_WRITER: "local", LOCAL_SIGNER_KEYS: JSON.stringify(keys) });
    expect(line).toContain("LOCAL_SIGNER_KEYS (must be a JSON object with exactly registrar, model and rules");
    expect(line).not.toContain(K1.slice(2));
  });

  test("MAX_TICK_MS defaults to 120000 and is bounded", () => {
    const r = parseWorkerEnv(CIRCLE);
    expect(r.ok && r.env.MAX_TICK_MS).toBe(120_000);
    expect(failure({ ...CIRCLE, MAX_TICK_MS: "10" })).toContain("MAX_TICK_MS");
  });

  test("the fast-lane cadences default to 250 / 500 / 1000 ms and are bounded", () => {
    const r = parseWorkerEnv(CIRCLE);
    expect(r.ok && [r.env.FAST_TICK_MS, r.env.CIRCLE_STATUS_POLL_MS, r.env.INFLIGHT_INDEX_MS, r.env.TICK_INTERVAL_MS]).toEqual([250, 500, 1000, 5000]);
    const ok = parseWorkerEnv({ ...CIRCLE, FAST_TICK_MS: "50", CIRCLE_STATUS_POLL_MS: "10000", INFLIGHT_INDEX_MS: "250" });
    expect(ok.ok && [ok.env.FAST_TICK_MS, ok.env.CIRCLE_STATUS_POLL_MS, ok.env.INFLIGHT_INDEX_MS]).toEqual([50, 10_000, 250]);
    for (const [name, low, high] of [
      ["FAST_TICK_MS", "49", "5001"],
      ["CIRCLE_STATUS_POLL_MS", "99", "10001"],
      ["INFLIGHT_INDEX_MS", "249", "30001"],
    ] as const) {
      expect(failure({ ...CIRCLE, [name]: low })).toContain(name);
      expect(failure({ ...CIRCLE, [name]: high })).toContain(name);
    }
  });

  test("the indexer limits default to 10 chunks per tick and a 30 s rate-limit cooldown, and are bounded", () => {
    const r = parseWorkerEnv(CIRCLE);
    expect(r.ok && [r.env.INDEXER_MAX_CHUNKS_PER_TICK, r.env.INDEXER_RATE_LIMIT_COOLDOWN_MS]).toEqual([10, 30_000]);
    const lo = parseWorkerEnv({ ...CIRCLE, INDEXER_MAX_CHUNKS_PER_TICK: "1", INDEXER_RATE_LIMIT_COOLDOWN_MS: "1000" });
    expect(lo.ok && [lo.env.INDEXER_MAX_CHUNKS_PER_TICK, lo.env.INDEXER_RATE_LIMIT_COOLDOWN_MS]).toEqual([1, 1000]);
    const hi = parseWorkerEnv({ ...CIRCLE, INDEXER_MAX_CHUNKS_PER_TICK: "200", INDEXER_RATE_LIMIT_COOLDOWN_MS: "600000" });
    expect(hi.ok && [hi.env.INDEXER_MAX_CHUNKS_PER_TICK, hi.env.INDEXER_RATE_LIMIT_COOLDOWN_MS]).toEqual([200, 600_000]);
    for (const [name, low, high] of [
      ["INDEXER_MAX_CHUNKS_PER_TICK", "0", "201"],
      ["INDEXER_RATE_LIMIT_COOLDOWN_MS", "999", "600001"],
    ] as const) {
      expect(failure({ ...CIRCLE, [name]: low })).toContain(name);
      expect(failure({ ...CIRCLE, [name]: high })).toContain(name);
    }
    expect(failure({ ...CIRCLE, INDEXER_MAX_CHUNKS_PER_TICK: "ten" })).toContain("INDEXER_MAX_CHUNKS_PER_TICK");
  });

  test("CHAIN_WRITER=local with NODE_ENV=production: refused", () => {
    const line = failure({ ...BASE, CHAIN_ID: "31337", CHAIN_WRITER: "local", NODE_ENV: "production", ALLOW_LOCAL_WRITER: "1", LOCAL_SIGNER_KEYS: KEYS });
    expect(line).toContain("CHAIN_WRITER (local is refused when NODE_ENV=production");
    expect(line).not.toContain(K1.slice(2));
  });

  test("local without keys, or with malformed keys, names LOCAL_SIGNER_KEYS and never echoes it", () => {
    expect(failure({ ...BASE, CHAIN_ID: "31337", CHAIN_WRITER: "local" })).toContain("LOCAL_SIGNER_KEYS (required when CHAIN_WRITER=local)");
    expect(failure({ ...BASE, CHAIN_ID: "31337", CHAIN_WRITER: "local", LOCAL_SIGNER_KEYS: "{not json" })).toContain("LOCAL_SIGNER_KEYS");
  });

  test("base and conditional problems are reported together", () => {
    const r = parseWorkerEnv({ ...CIRCLE, FOUNDER_ALERT_WEBHOOK_URL: undefined, TICK_INTERVAL_MS: "5", CIRCLE_API_KEY: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid.map((p) => p.name).sort()).toEqual(["CIRCLE_API_KEY", "FOUNDER_ALERT_WEBHOOK_URL", "TICK_INTERVAL_MS"]);
  });

  test("a bad CHAIN_WRITER is named", () => {
    expect(failure({ ...BASE, CHAIN_WRITER: "gas-station" })).toContain("CHAIN_WRITER (must be circle or local)");
  });
});

describe("migrate env", () => {
  test("MIGRATOR_DATABASE_URL is required and must be a postgres URL", () => {
    expect(parseMigrateEnv({ MIGRATOR_DATABASE_URL: "postgres://m:pw@h:5432/db" }).ok).toBe(true);
    const r = parseMigrateEnv({ DATABASE_URL: "postgres://m:pw@h:5432/db" });
    expect(r.ok ? [] : r.invalid).toEqual([{ name: "MIGRATOR_DATABASE_URL", problem: "required" }]);
  });
});
