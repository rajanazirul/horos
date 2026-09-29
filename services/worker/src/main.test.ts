// The worker entry point: env failures, the non-overlapping tick loop with SIGTERM, the tick summary, and one real
// tick through `buildWorker` on a migrated PGlite database with fake vendors.
import type { PGlite } from "@electric-sql/pglite";
import {
  CircleChainWriter,
  CircleKeyProvisioner,
  createLogger,
  LocalKeyChainWriter,
  localKeyProvisioner,
  ViemChainReader,
  type HorosDb,
  type SdnFetchResult,
} from "@horos/adapters";
import type { ChainReader, ChainWriter, FounderAlert, Notifier } from "@horos/core";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { parseWorkerEnv } from "./env.js";
import { buildWorker, main, runLoop, summarizeTick, vendorRuntime } from "./main.js";
import { migratedClient, migratedDump } from "./migrated-db.test-helpers.js";
import type { TickReport } from "./tick.js";

const SAMPLE = readFileSync(new URL("../../../fixtures/ofac/sdn-sample.csv", import.meta.url), "utf8");
const T0 = new Date("2026-09-28T12:00:00.000Z");

function capture() {
  const lines: string[] = [];
  return { log: createLogger({ service: "worker", write: (l) => lines.push(l) }), lines, entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const idleReport = (now: Date): TickReport => ({ job: "ofac-poll", window: now.toISOString().slice(0, 13), ran: false });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("main: environment failures", () => {
  test("CHAIN_WRITER=circle without CIRCLE_ENTITY_SECRET: exit code 1, named, no values", async () => {
    const stderr: string[] = [];
    const code = await main(
      {
        DATABASE_URL: "postgres://w:not-a-real-password@h:5432/db",
        CHAIN_ID: "5042002",
        ARC_RPC_PRIMARY: "https://rpc.primary.example",
        ARC_RPC_SECONDARY: "https://rpc.secondary.example",
        FOUNDER_ALERT_WEBHOOK_URL: "https://hooks.example.com/x",
        CHAIN_WRITER: "circle",
        CIRCLE_API_KEY: "TEST_API_KEY:aaa:bbb",
      },
      { stderr: (l) => stderr.push(l), onSignal: () => {} },
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("CIRCLE_ENTITY_SECRET");
    expect(stderr.join("\n")).not.toContain("TEST_API_KEY");
    expect(stderr.join("\n")).not.toContain("not-a-real-password");
  });

  test("CHAIN_WRITER=local under NODE_ENV=production: exit code 1", async () => {
    const stderr: string[] = [];
    const code = await main(
      {
        DATABASE_URL: "postgres://w:pw@h:5432/db",
        CHAIN_ID: "31337",
        ARC_RPC_PRIMARY: "http://127.0.0.1:8545",
        ARC_RPC_SECONDARY: "http://127.0.0.1:8545",
        FOUNDER_ALERT_WEBHOOK_URL: "https://hooks.example.com/x",
        CHAIN_WRITER: "local",
        NODE_ENV: "production",
        LOCAL_SIGNER_KEYS: JSON.stringify({ registrar: `0x${"11".repeat(32)}`, model: `0x${"12".repeat(32)}`, rules: `0x${"13".repeat(32)}` }),
      },
      { stderr: (l) => stderr.push(l), onSignal: () => {} },
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("CHAIN_WRITER");
    expect(stderr.join("\n")).not.toContain("11".repeat(32));
  });
});

describe("runLoop", () => {
  test("a tick longer than the interval never overlaps the next; abort stops after the current tick", async () => {
    const { log, entries } = capture();
    const stop = new AbortController();
    let active = 0;
    let maxActive = 0;
    let ticks = 0;
    let finishedAfterAbort = false;
    const loop = runLoop({
      intervalMs: 5,
      maxTickMs: 10_000,
      signal: stop.signal,
      log,
      tick: async (now) => {
        active++;
        maxActive = Math.max(maxActive, active);
        ticks++;
        await wait(30); // six intervals long
        active--;
        if (stop.signal.aborted) finishedAfterAbort = true;
        return idleReport(now);
      },
    });
    await wait(100);
    stop.abort(); // SIGTERM mid-tick
    await loop;
    expect(maxActive).toBe(1);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(ticks).toBeLessThanOrEqual(5);
    expect(finishedAfterAbort).toBe(true); // the in-flight tick completed before the loop returned
    expect(active).toBe(0);
    const tickLogs = entries().filter((e) => e["event"] === "tick");
    expect(tickLogs).toHaveLength(ticks);
    expect(tickLogs[0]).toMatchObject({ level: "info", service: "worker", ofac: { ran: false } });
  });

  test("a failing tick is logged (redacted) and the loop continues; the idle wait is cut short by abort", async () => {
    const { log, entries } = capture();
    const stop = new AbortController();
    let n = 0;
    const loop = runLoop({
      intervalMs: 60_000,
      maxTickMs: 10_000,
      signal: stop.signal,
      log,
      tick: async (now) => {
        n++;
        if (n === 1) throw new Error("rpc https://rpc.example/v2/secret-key-in-path down");
        return idleReport(now);
      },
    });
    await wait(20);
    stop.abort();
    const started = Date.now();
    await loop;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(n).toBe(1);
    const failed = entries().find((e) => e["event"] === "tick-failed");
    expect(failed?.["error"]).toEqual({ name: "Error", message: "rpc https://rpc.example down" });
  });
});

describe("runLoop: a hung tick", () => {
  test("a never-resolving tick ends the loop with tick-timeout, logs it and sends a bounded founder alert", async () => {
    const { log, entries } = capture();
    let ticks = 0;
    let alerts = 0;
    const exit = await runLoop({
      intervalMs: 5,
      maxTickMs: 50,
      signal: new AbortController().signal,
      log,
      tick: () => {
        ticks++;
        return new Promise<never>(() => {});
      },
      onTickTimeout: async () => void alerts++,
    });
    expect(exit).toBe("tick-timeout");
    expect(ticks).toBe(1); // no second tick overlaps the hung one
    expect(alerts).toBe(1);
    expect(entries().map((e) => e["event"])).toEqual(["tick-timeout"]);
    expect(entries()[0]).toMatchObject({ level: "error", maxTickMs: 50 });
  });

  test("a hanging or failing alert cannot keep the worker alive", async () => {
    const { log, entries } = capture();
    const started = Date.now();
    const exit = await runLoop({
      intervalMs: 5,
      maxTickMs: 20,
      alertTimeoutMs: 30,
      signal: new AbortController().signal,
      log,
      tick: () => new Promise<never>(() => {}),
      onTickTimeout: () => new Promise<void>(() => {}),
    });
    expect(exit).toBe("tick-timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(entries().map((e) => e["event"])).toEqual(["tick-timeout", "tick-timeout-alert-failed"]);
  });
});

describe("summarizeTick", () => {
  test("counts only; no addresses, keys or record bodies", () => {
    const report: TickReport = {
      job: "ofac-poll",
      window: "2026-09-28T12",
      ran: true,
      outcome: { kind: "activated", snapshotId: "s1", addressCount: 3 },
      provision: { provisioned: ["c1"], failed: [] },
      outbox: {
        recovered: 0,
        polled: [{ id: "i1", kind: "waiting" }],
        processed: [
          { id: "i2", kind: "submitted", fn: "register", txId: "t" },
          { id: "i3", kind: "noop" },
          { id: "i4", kind: "noop" },
        ],
      },
      indexer: {
        wallets: [{ policyWallet: "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c", scope: "enforced:x", chunks: 2, confirmed: 1, external: 0, paid: 3, alerts: 0 }],
        reconciled: 1,
        alertsDelivered: [],
        alertErrors: [],
      },
    };
    const s = summarizeTick(report, 12);
    expect(s).toEqual({
      event: "tick",
      durationMs: 12,
      ofac: { window: "2026-09-28T12", ran: true, outcome: "activated" },
      provision: { provisioned: 1, failed: [] },
      outbox: { recovered: 0, polled: { waiting: 1 }, processed: { submitted: 1, noop: 2 } },
      indexer: { wallets: 1, chunks: 2, confirmed: 1, external: 0, paid: 3, errors: [], reconciled: 1, alertsDelivered: 0, alertErrors: 0 },
    });
    expect(JSON.stringify(s)).not.toContain("0x7ed77");
  });
});

describe("buildWorker", () => {
  beforeAll(async () => {
    await migratedDump();
  });
  const clients: PGlite[] = [];
  afterEach(async () => {
    while (clients.length) await clients.pop()?.close();
  });

  test("one tick runs the OFAC poll, provisioning, the outbox and the indexer against the database", async () => {
    const client = await migratedClient();
    clients.push(client);
    const unused = new Proxy({} as ChainReader & ChainWriter, {
      get: () => async () => {
        throw new Error("no chain access expected with nothing bound");
      },
    });
    const alerts: FounderAlert[] = [];
    const notifier: Notifier = { notify: async (a) => void alerts.push(a) };
    const worker = buildWorker({
      db: drizzle(client) as unknown as HorosDb,
      reader: unused,
      writer: unused,
      provisioner: localKeyProvisioner({}),
      fetchSdn: async (): Promise<SdnFetchResult> => ({ status: 200, body: SAMPLE }),
      notifier,
    });
    const report = await worker.tick(T0);
    expect(report).toMatchObject({ job: "ofac-poll", ran: true, outcome: { kind: "activated" } });
    expect(report.provision).toEqual({ provisioned: [], failed: [] });
    expect(report.outbox?.processed).toEqual([]);
    expect(report.indexer?.wallets).toEqual([]);
    expect(alerts).toEqual([]);
  });
});

// Well-known Foundry/Anvil dev keys. Test-only; never funded on any real network.
const LOCAL_KEYS = {
  registrar: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  model: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  rules: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
const LOCAL_ENV = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  CHAIN_ID: "31337",
  ARC_RPC_PRIMARY: "http://127.0.0.1:9",
  ARC_RPC_SECONDARY: "http://127.0.0.1:9",
  FOUNDER_ALERT_WEBHOOK_URL: "http://127.0.0.1:9/alerts",
  OFAC_SDN_URL: "http://127.0.0.1:9/sdn.csv",
  CHAIN_WRITER: "local",
  LOCAL_SIGNER_KEYS: JSON.stringify(LOCAL_KEYS),
  TICK_INTERVAL_MS: "100",
} as const;

describe("main: the success path", () => {
  beforeAll(async () => {
    await migratedDump();
  });
  const clients: PGlite[] = [];
  afterEach(async () => {
    while (clients.length) await clients.pop()?.close();
  });

  test("boots on a valid local env, ticks, and resolves 0 after SIGTERM once the current tick finishes", async () => {
    const client = await migratedClient();
    clients.push(client);
    const handlers = new Map<string, () => void>();
    const lines: string[] = [];
    const done = main(LOCAL_ENV, {
      stderr: (l) => lines.push(l),
      onSignal: (sig, h) => void handlers.set(sig, h),
      db: drizzle(client) as unknown as HorosDb,
      write: (l) => lines.push(l),
    });
    for (let i = 0; i < 200 && !lines.some((l) => l.includes('"event":"tick"')); i++) await wait(25);
    expect(lines.some((l) => l.includes('"event":"tick"'))).toBe(true);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")?.();
    expect(await done).toBe(0);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events[0]).toBe("worker-started");
    expect(events.slice(-2)).toEqual(["worker-stopping", "worker-stopped"]);
    const out = lines.join("\n");
    for (const k of Object.values(LOCAL_KEYS)) expect(out).not.toContain(k.slice(2));
  });
});

describe("vendorRuntime", () => {
  const base = { ...LOCAL_ENV, CHAIN_ID: "5042002", ALLOW_LOCAL_WRITER: "1" };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function envOf(raw: Record<string, string>) {
    const r = parseWorkerEnv(raw);
    if (!r.ok) throw new Error(JSON.stringify(r.invalid));
    return r.env;
  }

  test("circle: the Circle writer and provisioner", () => {
    const v = vendorRuntime(envOf({ ...base, CHAIN_WRITER: "circle", CIRCLE_API_KEY: "TEST_API_KEY:a:b", CIRCLE_ENTITY_SECRET: "00".repeat(32) }));
    expect(v.writer).toBeInstanceOf(CircleChainWriter);
    expect(v.provisioner).toBeInstanceOf(CircleKeyProvisioner);
    expect(v.reader).toBeInstanceOf(ViemChainReader);
  });

  test("local: the local-key writer, and a provisioner that returns the local role addresses", async () => {
    const v = vendorRuntime(envOf(base));
    expect(v.writer).toBeInstanceOf(LocalKeyChainWriter);
    const keys = await v.provisioner.provision("any-customer");
    expect(keys.registrar.address).toBe(privateKeyToAccount(LOCAL_KEYS.registrar).address.toLowerCase());
    expect(keys.model.address).toBe(privateKeyToAccount(LOCAL_KEYS.model).address.toLowerCase());
    expect(keys.rules.address).toBe(privateKeyToAccount(LOCAL_KEYS.rules).address.toLowerCase());
  });

  test("the SDN fetcher and the founder alert use OFAC_SDN_URL and FOUNDER_ALERT_WEBHOOK_URL", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      urls.push(String(url));
      return new Response(null, { status: 503 });
    });
    const v = vendorRuntime(envOf({ ...base, OFAC_SDN_URL: "https://sdn.example/SDN.CSV", FOUNDER_ALERT_WEBHOOK_URL: "https://hooks.example/alert" }));
    expect(await v.fetchSdn(undefined)).toEqual({ status: 503 });
    await expect(v.notifier.notify({ kind: "worker-tick-timeout", maxTickMs: 1, message: "test" })).rejects.toThrow(/responded 503/);
    expect(urls).toEqual(["https://sdn.example/SDN.CSV", "https://hooks.example/alert"]);
  });
});
