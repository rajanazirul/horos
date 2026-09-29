import { describe, expect, test } from "vitest";
import { z } from "zod";
import { describeEnvFailure, forbidden, intFromString, parseEnv, sharedEnvShape } from "./env.js";

const Schema = z.object({ ...sharedEnvShape, N: intFromString(1, 10).default(5), NOPE: forbidden("must not be set") });

const VALID = {
  DATABASE_URL: "postgres://horos_api:pw@db.internal:5432/railway",
  CHAIN_ID: "5042002",
  ARC_RPC_PRIMARY: "https://rpc.primary.example",
  ARC_RPC_SECONDARY: "https://rpc.secondary.example",
};

describe("parseEnv", () => {
  test("a valid environment parses; defaults apply; empty strings count as unset", () => {
    const r = parseEnv(Schema, { ...VALID, N: "", LOG_LEVEL: "debug", UNRELATED: "x" });
    expect(r).toEqual({ ok: true, env: { ...VALID, CHAIN_ID: 5042002, N: 5, LOG_LEVEL: "debug" } });
  });

  test("failures name every invalid variable once, with value-free problems", () => {
    const r = parseEnv(Schema, { ...VALID, DATABASE_URL: "mysql://secret-value@h/db", CHAIN_ID: "abc-secret", N: "11", NOPE: "secret-value", ARC_RPC_PRIMARY: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalid.map((p) => p.name).sort()).toEqual(["ARC_RPC_PRIMARY", "CHAIN_ID", "DATABASE_URL", "N", "NOPE"]);
    const line = describeEnvFailure("svc", r.invalid);
    expect(line).toMatch(/^svc: invalid environment: /);
    expect(line).toContain("ARC_RPC_PRIMARY (required)");
    expect(line).toContain("NOPE (must not be set)");
    expect(line).not.toContain("secret-value");
    expect(line).not.toContain("abc-secret");
    expect(line).not.toContain("mysql");
  });
});
