// Boot smoke for the api entry point: env failures exit 1 without values; a valid env serves every route on a real
// socket, with `/healthz` pinging the database (the test Postgres here) and a fake chain reader.
import { randomBytes } from "node:crypto";
import { emptyDb, freshDb, type TestClient } from "@horos/adapters/testing";
import { bundledMigrationCount, createLogger } from "@horos/adapters";
import { STANDARD_PRESET, toOffchainPolicy, type ChainReader } from "@horos/core";
import { afterEach, describe, expect, test } from "vitest";
import { parseApiEnv, type ApiEnv } from "./env.js";
import { listen, main, startApi, type RunningApi } from "./server.js";

const ENV = {
  DATABASE_URL: "postgres://horos_api:not-a-real-password@db.internal:5432/railway",
  CHAIN_ID: "5042002",
  ARC_RPC_PRIMARY: "https://rpc.primary.example/v2/key-in-path",
  ARC_RPC_SECONDARY: "https://rpc.secondary.example",
  ADMIN_TOKEN: "test-admin-token-not-a-secret-0123456789",
} as const;

/** Every chain read fails: the routes exercised here never reach the chain. */
const unusedChain = new Proxy({} as ChainReader, {
  get: () => async () => {
    throw new Error("chain not used in this test");
  },
});

function validEnv(extra: Record<string, string> = {}): ApiEnv {
  const r = parseApiEnv({ ...ENV, ...extra });
  if (!r.ok) throw new Error("test env invalid");
  return r.env;
}

const running: RunningApi[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.close();
  while (clients.length) await clients.pop()?.close();
});

describe("main: environment failures", () => {
  function runMain(raw: Record<string, string | undefined>) {
    const stderr: string[] = [];
    const exits: number[] = [];
    return main(raw, { stderr: (l) => stderr.push(l), exit: (c) => exits.push(c), onSignal: () => {} }).then((r) => ({ r, stderr, exits }));
  }

  test("missing ADMIN_TOKEN: exit 1, the message names ADMIN_TOKEN and prints no values", async () => {
    const { r, stderr, exits } = await runMain({ ...ENV, ADMIN_TOKEN: undefined });
    expect(r).toBeUndefined();
    expect(exits).toEqual([1]);
    expect(stderr.join("\n")).toContain("ADMIN_TOKEN");
    for (const v of Object.values(ENV)) expect(stderr.join("\n")).not.toContain(v);
    expect(stderr.join("\n")).not.toContain("not-a-real-password");
    expect(stderr.join("\n")).not.toContain("key-in-path");
  });

  test("a Circle secret in the api env: exit 1 naming it, value not printed", async () => {
    const { exits, stderr } = await runMain({ ...ENV, CIRCLE_ENTITY_SECRET: "TEST_ENTITY_SECRET_VALUE" });
    expect(exits).toEqual([1]);
    expect(stderr.join("\n")).toContain("CIRCLE_ENTITY_SECRET");
    expect(stderr.join("\n")).not.toContain("TEST_ENTITY_SECRET_VALUE");
  });
});

describe("startApi: boot smoke", () => {
  async function boot(extra: Record<string, string> = {}) {
    const { client, db } = await freshDb();
    clients.push(client);
    const lines: string[] = [];
    const api = await startApi(validEnv({ PUBLIC_DEMO_SCOPE: "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80", ...extra }), {
      db,
      chainReader: unusedChain,
      log: createLogger({ service: "api", write: (l) => lines.push(l) }),
      port: 0,
    });
    running.push(api);
    return { api, client, lines, url: (p: string) => `http://127.0.0.1:${api.port}${p}` };
  }

  test("serves /healthz 200 with a reachable database, and mounts the policy, check and read routes", async () => {
    const { url, lines } = await boot();
    const health = await fetch(url("/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", db: "ok", migrations: { applied: bundledMigrationCount(), bundled: bundledMigrationCount() } });

    expect((await fetch(url("/v1/policy-versions"), { method: "POST", body: "{}" })).status).toBe(401);
    const check = await fetch(url("/v1/check"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(check.status).toBe(400);
    expect(((await check.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
    expect((await fetch(url("/v1/scopes/enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80/records"))).status).toBe(200);
    const nope = await fetch(url("/nope"));
    expect(nope.status).toBe(404);
    expect(await nope.json()).toEqual({ error: { code: "not_found", retryable: false, message: "no such route" } });

    const out = lines.join("\n");
    expect(out).toContain('"event":"api-listening"');
    expect(out).not.toContain(ENV.ADMIN_TOKEN);
    expect(out).not.toContain("not-a-real-password");
  });

  test("mounts Shadow Mode: admin sign-up, an API-key Check, API-key reads and the summary (key never logged)", async () => {
    const { url, lines } = await boot();
    const json = { "content-type": "application/json" };
    const signup = await fetch(url("/v1/shadow"), {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
      body: JSON.stringify({ payment_address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" }),
    });
    expect(signup.status).toBe(200);
    expect(signup.headers.get("cache-control")).toBe("no-store");
    const { scope, apiKey } = (await signup.json()) as { scope: string; apiKey: string };
    const key = { "x-horos-api-key": apiKey };
    // The chain is down in this boot: hasCode fails, so the first contact holds (conservatively) and nothing is written on-chain.
    const check = await fetch(url("/v1/shadow/check"), {
      method: "POST",
      headers: { ...json, ...key },
      body: JSON.stringify({ counterparty: "0x1111111111111111111111111111111111111111", amount: "1000000" }),
    });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ decision: "hold", advisory: true, limit_write: "none" });
    const records = await fetch(url(`/v1/scopes/${scope}/records`), { headers: key });
    expect(records.status).toBe(200);
    expect(((await records.json()) as { records: unknown[] }).records).toHaveLength(1);
    const summary = await fetch(url(`/v1/scopes/${scope}/shadow-summary`), { headers: key });
    expect(await summary.json()).toEqual({ advisory: 0, would_have_caught: 1 });
    expect(lines.join("\n")).not.toContain(apiKey);
  });

  test("/healthz answers 503 when the database is unreachable", async () => {
    const { url, client } = await boot();
    await client.close();
    const health = await fetch(url("/healthz"));
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "unavailable", db: "unreachable" });
  });

  test("an uncaught handler error answers the 500 internal envelope and is logged at error level", async () => {
    const { url, client, lines } = await boot();
    await client.close();
    const body = { scope: "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80", presetVersion: "standard@1", policy: toOffchainPolicy(STANDARD_PRESET.offchain) };
    const res = await fetch(url("/v1/policy-versions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", retryable: true, message: "internal error" } });
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e["event"] === "unhandled-error");
    expect(logged).toMatchObject({ level: "error", method: "POST", path: "/v1/policy-versions" });
  });
});

describe("startApi: health, shutdown and binding", () => {
  async function bootDb(migrate: boolean) {
    const { client, db } = await (migrate ? freshDb() : emptyDb());
    clients.push(client);
    const api = await startApi(validEnv(), { db, chainReader: unusedChain, log: createLogger({ service: "api", write: () => {} }), port: 0 });
    running.push(api);
    return { api, client, url: (p: string) => `http://127.0.0.1:${api.port}${p}` };
  }

  test("/healthz answers 503 schema-behind until every bundled migration is applied", async () => {
    const { url, client } = await bootDb(true);
    await client.query("DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)");
    const behind = await fetch(url("/healthz"));
    expect(behind.status).toBe(503);
    expect(await behind.json()).toEqual({ status: "schema-behind", db: "ok", migrations: { applied: bundledMigrationCount() - 1, bundled: bundledMigrationCount() } });
  });

  test("/healthz answers 503 schema-behind on an unmigrated database", async () => {
    const { url } = await bootDb(false);
    const r = await fetch(url("/healthz"));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { status: string }).status).toBe("schema-behind");
  });

  test("close is idempotent: repeated calls share one shutdown", async () => {
    const { api } = await bootDb(true);
    running.pop();
    const a = api.close();
    const b = api.close();
    expect(b).toBe(a);
    await Promise.all([a, b]);
  });

  test("listen rejects on a bind error instead of hanging", async () => {
    const { api } = await bootDb(true);
    const { Hono } = await import("hono");
    await expect(listen(new Hono(), api.port)).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("main: signals", () => {
  function harness(close: () => Promise<void>) {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    let closes = 0;
    const io = {
      stderr: () => {},
      exit: (c: number) => void exits.push(c),
      onSignal: (sig: NodeJS.Signals, h: () => void) => void handlers.set(sig, h),
      start: async () => ({ port: 1, close: () => (closes++, close()) }),
      shutdownDeadlineMs: 50,
    };
    return { io, handlers, exits, closes: () => closes };
  }

  test("SIGTERM then SIGINT (or a repeat) runs the shutdown once and exits 0", async () => {
    const h = harness(async () => {});
    await main(ENV, h.io);
    h.handlers.get("SIGTERM")?.();
    h.handlers.get("SIGTERM")?.();
    h.handlers.get("SIGINT")?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.closes()).toBe(1);
    expect(h.exits).toEqual([0]);
  });

  test("a shutdown that hangs past the deadline exits 1", async () => {
    const h = harness(() => new Promise<void>(() => {}));
    await main(ENV, h.io);
    h.handlers.get("SIGTERM")?.();
    await new Promise((r) => setTimeout(r, 120));
    expect(h.exits).toEqual([1]);
  });
});

describe("startApi: the Check rate limit keys", () => {
  const body = () =>
    JSON.stringify({
      policy_wallet: "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c",
      counterparty: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      auth: { nonce: `0x${randomBytes(32).toString("hex")}`, expiry: "2026-09-28T12:02:00.000Z", signature: `0x${"0".repeat(130)}` },
    });

  async function bootLimited() {
    const { client, db } = await freshDb();
    clients.push(client);
    const api = await startApi(validEnv({ CHECK_RATE_PER_MINUTE: "1", TRUSTED_PROXY_HOPS: "1" }), {
      db,
      chainReader: unusedChain,
      log: createLogger({ service: "api", write: () => {} }),
      port: 0,
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    running.push(api);
    const check = async (xff?: string) =>
      (
        await fetch(`http://127.0.0.1:${api.port}/v1/check`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(xff === undefined ? {} : { "x-forwarded-for": xff }) },
          body: body(),
        })
      ).status;
    return check;
  }

  test("with one trusted hop, different right-most x-forwarded-for addresses are limited separately", async () => {
    const check = await bootLimited();
    expect(await check("203.0.113.9, 198.51.100.1")).toBe(200);
    expect(await check("203.0.113.7, 198.51.100.1")).toBe(429); // same right-most hop, spoofed left part ignored
    expect(await check("198.51.100.2")).toBe(200);
    expect(await check("198.51.100.2")).toBe(429);
  });

  test("without the header the socket address (not \"unknown\") is the key", async () => {
    const check = await bootLimited();
    expect(await check()).toBe(200);
    expect(await check("unknown")).toBe(200); // a key literally named "unknown" is a different bucket
    expect(await check()).toBe(429);
    // The socket address of a local fetch is the loopback address, in IPv4 or IPv4-mapped IPv6 form.
    const sameAsSocket = [await check("127.0.0.1"), await check("::ffff:127.0.0.1")];
    expect(sameAsSocket).toContain(429);
  });
});
