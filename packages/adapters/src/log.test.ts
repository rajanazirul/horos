import { describe, expect, test } from "vitest";
import { createLogger, isSecretKey, redactLogValue, REDACTED } from "./log.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");

function capture(level?: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const log = createLogger({ service: "test", write: (l) => lines.push(l), now: () => NOW, ...(level === undefined ? {} : { level }) });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("redacting JSON logger", () => {
  test("authorization, signature and the Circle secrets are redacted at any depth", () => {
    const { log, lines, parsed } = capture();
    log.info({
      event: "x",
      authorization: "Bearer admin-token-value-0123456789abcdef",
      nested: { signature: "0xdeadbeef", CIRCLE_ENTITY_SECRET: "entity-secret-value", deeper: [{ circleApiKey: "TEST_API_KEY:abc:def" }] },
      CIRCLE_API_KEY: "TEST_API_KEY:abc:def",
    });
    const out = lines.join("\n");
    for (const secret of ["admin-token-value", "0xdeadbeef", "entity-secret-value", "TEST_API_KEY"]) expect(out).not.toContain(secret);
    const [e] = parsed();
    expect(e).toMatchObject({
      event: "x",
      authorization: REDACTED,
      nested: { signature: REDACTED, CIRCLE_ENTITY_SECRET: REDACTED, deeper: [{ circleApiKey: REDACTED }] },
      CIRCLE_API_KEY: REDACTED,
    });
  });

  test("an RPC URL with a key in its path, and a webhook URL with a token, are reduced to their origin", () => {
    const { log, lines, parsed } = capture();
    log.warn({
      event: "rpc-failed",
      rpc: "https://arc-testnet.example-rpc.io/v2/sk_live_abcdef123456",
      error: new Error("request to https://arc-testnet.example-rpc.io/v2/sk_live_abcdef123456 failed; alert https://hooks.example.com/services/T0/B0/xyzsecret?token=q"),
    });
    const out = lines.join("\n");
    expect(out).not.toContain("sk_live_abcdef123456");
    expect(out).not.toContain("xyzsecret");
    const [e] = parsed();
    expect(e?.["rpc"]).toBe("https://arc-testnet.example-rpc.io");
    expect(e?.["error"]).toEqual({
      name: "Error",
      message: "request to https://arc-testnet.example-rpc.io failed; alert https://hooks.example.com",
    });
  });

  test("postgres connection strings and database-url keys never reach the log", () => {
    const { log, lines } = capture();
    log.error({ event: "db", error: "connect postgres://horos_api:pw-secret@db.internal:5432/railway failed", DATABASE_URL: "postgres://u:p@h/db" });
    const out = lines.join("\n");
    expect(out).not.toContain("pw-secret");
    expect(out).not.toContain("u:p@h");
  });

  test("envelope, level filtering, bigints and envelope fields that cannot be spoofed", () => {
    const { log, parsed } = capture("warn");
    log.info({ event: "dropped" });
    log.warn({ event: "kept", amount: 10n ** 20n, level: "debug", ts: "spoofed" });
    expect(parsed()).toEqual([{ ts: NOW.toISOString(), level: "warn", service: "test", event: "kept", amount: "100000000000000000000" }]);
  });

  test("secret-key matching is case- and separator-insensitive; ordinary keys pass", () => {
    for (const k of [
      "Authorization",
      "x-horos-api-key",
      "x-api-key",
      "apiKey",
      "circle_entity_secret",
      "entitySecretCiphertext",
      "ADMIN_TOKEN",
      "accessToken",
      "bearerToken",
      "privateKey",
      "LOCAL_SIGNER_KEYS",
      "credentials",
    ])
      expect(isSecretKey(k)).toBe(true);
    for (const k of ["recordId", "recordHash", "txHash", "scope", "trigger", "signedAt", "policyWallet", "webhook"]) expect(isSecretKey(k)).toBe(false);
  });

  test("Circle API keys and bearer credentials inside strings are redacted; hashes are kept", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const { log, lines } = capture();
    log.error({ event: "x", message: `circle said TEST_API_KEY:abc123:def456 and LIVE_API_KEY:zz:yy; header Bearer eyJhbGciOi.secret tx ${hash}` });
    const out = lines.join("\n");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zz:yy");
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).toContain(hash);
  });

  test("a sub-object shared by siblings is printed in full, not as circular", () => {
    const shared = { count: 2 };
    expect(redactLogValue({ a: shared, b: shared, list: [shared, shared] })).toEqual({ a: shared, b: shared, list: [shared, shared] });
  });

  test("circular structures and deep nesting do not throw", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    expect(redactLogValue(a)).toEqual({ name: "a", self: "[circular]" });
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i++) deep = deep["n"] = {};
    expect(JSON.stringify(redactLogValue(root))).toContain("[truncated]");
  });
});
