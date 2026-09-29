import { describeEnvFailure } from "@horos/adapters";
import { describe, expect, test } from "vitest";
import { parseApiEnv } from "./env.js";

const VALID_API_ENV = {
  DATABASE_URL: "postgres://horos_api:not-a-real-password@db.internal:5432/railway",
  CHAIN_ID: "5042002",
  ARC_RPC_PRIMARY: "https://rpc.primary.example/v2/key-in-path",
  ARC_RPC_SECONDARY: "https://rpc.secondary.example",
  ADMIN_TOKEN: "test-admin-token-not-a-secret-0123456789",
} as const;

function failure(raw: Record<string, string | undefined>): string {
  const r = parseApiEnv(raw);
  if (r.ok) throw new Error("expected an invalid environment");
  return describeEnvFailure("horos-api", r.invalid);
}

describe("api env", () => {
  test("the full valid env parses, with PORT 8080 and TRUSTED_PROXY_HOPS 1 by default", () => {
    const r = parseApiEnv({ ...VALID_API_ENV, PUBLIC_DEMO_SCOPE: "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80", JEV_API_KEY: "unused" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env).toMatchObject({ PORT: 8080, CHAIN_ID: 5042002, TRUSTED_PROXY_HOPS: 1, PUBLIC_DEMO_SCOPE: "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80" });
    expect(r.env.CHECK_RATE_PER_MINUTE).toBeUndefined();
    expect(r.env.CHAIN_READ_CACHE_MS).toBe(5000);
  });

  test("CHAIN_READ_CACHE_MS: 0 disables, a negative value is named", () => {
    const off = parseApiEnv({ ...VALID_API_ENV, CHAIN_READ_CACHE_MS: "0" });
    expect(off.ok && off.env.CHAIN_READ_CACHE_MS).toBe(0);
    const bad = parseApiEnv({ ...VALID_API_ENV, CHAIN_READ_CACHE_MS: "-1" });
    expect(bad.ok ? [] : bad.invalid.map((p) => p.name)).toEqual(["CHAIN_READ_CACHE_MS"]);
  });

  test("missing ADMIN_TOKEN: named, no values printed", () => {
    const line = failure({ ...VALID_API_ENV, ADMIN_TOKEN: undefined });
    expect(line).toBe("horos-api: invalid environment: ADMIN_TOKEN (required)");
  });

  test("a short ADMIN_TOKEN is refused without echoing it", () => {
    const line = failure({ ...VALID_API_ENV, ADMIN_TOKEN: "short-secret" });
    expect(line).toContain("ADMIN_TOKEN (must be at least 32 characters)");
    expect(line).not.toContain("short-secret");
  });

  test.each(["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"])("%s present in the api env: refused, value not printed", (name) => {
    const line = failure({ ...VALID_API_ENV, [name]: "TEST_CIRCLE_VALUE:abc:def" });
    expect(line).toContain(`${name} (must not be set for the api`);
    expect(line).not.toContain("TEST_CIRCLE_VALUE");
  });

  test.each(["MIGRATOR_DATABASE_URL", "LOCAL_SIGNER_KEYS"])("%s present in the api env: refused, value not printed", (name) => {
    const line = failure({ ...VALID_API_ENV, [name]: "postgres://horos_migrator:migrator-pw-value@h/db" });
    expect(line).toContain(`${name} (must not be set for the api (worker-only))`);
    expect(line).not.toContain("migrator-pw-value");
  });

  test("malformed PORT, PUBLIC_DEMO_SCOPE, TRUSTED_PROXY_HOPS and CHECK_RATE_PER_MINUTE are each named", () => {
    const r = parseApiEnv({ ...VALID_API_ENV, PORT: "80x", PUBLIC_DEMO_SCOPE: "enforced:nope", TRUSTED_PROXY_HOPS: "-1", CHECK_RATE_PER_MINUTE: "0" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid.map((p) => p.name).sort()).toEqual(["CHECK_RATE_PER_MINUTE", "PORT", "PUBLIC_DEMO_SCOPE", "TRUSTED_PROXY_HOPS"]);
  });
});
