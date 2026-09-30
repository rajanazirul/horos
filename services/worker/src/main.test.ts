// The worker entry point: env failures, the non-overlapping tick loop with SIGTERM, the tick summary, and one real
// tick through `buildWorker` on a migrated test database with fake vendors.
import { freshDb, type TestClient } from "@horos/adapters/testing";
import {
  CircleChainWriter,
  CircleKeyProvisioner,
  createLogger,
  LocalKeyChainWriter,
  localKeyProvisioner,
  ViemChainReader,
  type SdnFetchResult,
} from "@horos/adapters";
import type { ChainReader, ChainWriter, FounderAlert, Notifier } from "@horos/core";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseWorkerEnv } from "./env.js";
import { buildWorker, main, runLoop, summarizeFastPass, summarizeTick, vendorRuntime } from "./main.js";
import type { WalletIndexReport } from "./indexer.js";
import type { FastPassReport, TickReport } from "./tick.js";

const SAMPLE = readFileSync(new URL("../../../fixtures/ofac/sdn-sample.csv", import.meta.url), "utf8");
const T0 = new Date("2026-09-28T12:00:00.000Z");

function capture() {
  const lines: string[] = [];
  return { log: createLogger({ service: "worker", write: (l) => lines.push(l) }), lines, entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const idleReport = (now: Date): TickReport => ({ job: "ofac-poll", window: now.toISOString().slice(0, 13), ran: false });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noFastPass = async (): Promise<FastPassReport> => {
  throw new Error("no fast pass expected");
};

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
      fastIntervalMs: 5,
      fullIntervalMs: 0, // every wake is a full tick
      maxTickMs: 10_000,
      signal: stop.signal,
      log,
      fastPass: noFastPass,
      fullTick: async (now) => {
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
      fastIntervalMs: 60_000,
      fullIntervalMs: 60_000,
      maxTickMs: 10_000,
      signal: stop.signal,
      log,
      fastPass: noFastPass,
      fullTick: async (now) => {
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

describe("runLoop: fast lane and full tick (fake clock)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("wakes every FAST_TICK_MS; a full tick every TICK_INTERVAL_MS, fast passes between; never two at once", async () => {
    vi.useFakeTimers({ now: T0 });
    const { log, entries } = capture();
    const stop = new AbortController();
    const starts: [string, number][] = [];
    let active = 0;
    let maxActive = 0;
    const pass = async (kind: string, now: Date, ms: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      starts.push([kind, now.getTime() - T0.getTime()]);
      await new Promise((r) => setTimeout(r, ms));
      active--;
    };
    const loop = runLoop({
      fastIntervalMs: 250,
      fullIntervalMs: 5000,
      maxTickMs: 60_000,
      signal: stop.signal,
      log,
      fullTick: async (now) => (await pass("full", now, 100), idleReport(now)),
      fastPass: async (now) => (await pass("fast", now, 10), {}),
    });
    await vi.advanceTimersByTimeAsync(10_050);
    stop.abort();
    await vi.runOnlyPendingTimersAsync();
    expect(await loop).toBe("stopped");
    expect(maxActive).toBe(1);
    expect(starts.filter(([k]) => k === "full").map(([, t]) => t)).toEqual([0, 5000, 10_000]);
    const fast = starts.filter(([k]) => k === "fast").map(([, t]) => t);
    expect(fast).toEqual(Array.from({ length: 38 }, (_, i) => 250 * (i + 1 + (i >= 19 ? 1 : 0))));
    // Idle fast passes are not logged; each full tick is.
    expect(entries().map((e) => e["event"])).toEqual(["tick", "tick", "tick"]);
  });

  test("a slow full tick delays the next wake instead of overlapping it; the full cadence is measured start to start", async () => {
    vi.useFakeTimers({ now: T0 });
    const { log } = capture();
    const stop = new AbortController();
    const starts: [string, number][] = [];
    let active = 0;
    let maxActive = 0;
    const loop = runLoop({
      fastIntervalMs: 250,
      fullIntervalMs: 1000,
      maxTickMs: 60_000,
      signal: stop.signal,
      log,
      fullTick: async (now) => {
        active++;
        maxActive = Math.max(maxActive, active);
        starts.push(["full", now.getTime() - T0.getTime()]);
        await new Promise((r) => setTimeout(r, 600));
        active--;
        return idleReport(now);
      },
      fastPass: async (now) => {
        active++;
        maxActive = Math.max(maxActive, active);
        starts.push(["fast", now.getTime() - T0.getTime()]);
        active--;
        return { outbox: { processed: [{ id: "i1", kind: "noop" }] } };
      },
    });
    await vi.advanceTimersByTimeAsync(2100);
    stop.abort();
    await vi.runOnlyPendingTimersAsync();
    await loop;
    expect(maxActive).toBe(1);
    expect(starts).toEqual([
      ["full", 0],
      ["fast", 600],
      ["fast", 850],
      ["full", 1100],
      ["fast", 1700],
      ["fast", 1950],
    ]);
  });
});

describe("summarizeFastPass", () => {
  test("undefined when the pass did nothing; counts otherwise", () => {
    expect(summarizeFastPass({}, 1)).toBeUndefined();
    expect(summarizeFastPass({ outbox: { polled: [], processed: [] } }, 1)).toBeUndefined();
    expect(
      summarizeFastPass(
        {
          outbox: { polled: [{ id: "i1", kind: "tx-hash" }], processed: [{ id: "i2", kind: "submitted", fn: "tighten", txId: "t" }] },
          indexer: { wallets: [{ policyWallet: "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c", scope: "enforced:x", chunks: 1, confirmed: 1, external: 0, paid: 0, alerts: 0 }] },
        },
        3,
      ),
    ).toEqual({ event: "fast-pass", durationMs: 3, outbox: { polled: { "tx-hash": 1 }, processed: { submitted: 1 } }, indexer: { wallets: 1, confirmed: 1, errors: [] } });
  });

  test("a wallet cooling down: the rate-limit error once when it starts, then nothing logged while it is skipped", () => {
    const base = { policyWallet: "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c", scope: "enforced:x", chunks: 0, confirmed: 0, external: 0, paid: 0, alerts: 0 } as const;
    const until = new Date("2026-09-28T12:00:30.000Z");
    expect(summarizeFastPass({ indexer: { wallets: [{ ...base, error: "rate limit exceeded", coolingDownUntil: until }] } }, 1)).toEqual({
      event: "fast-pass",
      durationMs: 1,
      indexer: { wallets: 1, confirmed: 0, errors: ["rate limit exceeded"], coolingDown: 1 },
    });
    expect(summarizeFastPass({ indexer: { wallets: [{ ...base, coolingDownUntil: until }] } }, 1)).toBeUndefined();
  });
});

describe("runLoop: a hung tick", () => {
  test("a never-resolving tick ends the loop with tick-timeout, logs it and sends a bounded founder alert", async () => {
    const { log, entries } = capture();
    let ticks = 0;
    let alerts = 0;
    const exit = await runLoop({
      fastIntervalMs: 5,
      fullIntervalMs: 5,
      maxTickMs: 50,
      signal: new AbortController().signal,
      log,
      fastPass: noFastPass,
      fullTick: () => {
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
      fastIntervalMs: 5,
      fullIntervalMs: 5,
      maxTickMs: 20,
      alertTimeoutMs: 30,
      signal: new AbortController().signal,
      log,
      fastPass: noFastPass,
      fullTick: () => new Promise<never>(() => {}),
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

  test("a wallet cooling down after a rate limit is counted; its error is not repeated on the ticks that skip it", () => {
    const base = { policyWallet: "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c", scope: "enforced:x", chunks: 0, confirmed: 0, external: 0, paid: 0, alerts: 0 } as const;
    const tick = (w: WalletIndexReport): TickReport => ({
      job: "ofac-poll",
      window: "2026-09-28T12",
      ran: false,
      indexer: { wallets: [w], reconciled: 0, alertsDelivered: [], alertErrors: [] },
    });
    const until = new Date("2026-09-28T12:00:30.000Z");
    expect(summarizeTick(tick({ ...base, error: "rate limit exceeded", coolingDownUntil: until }), 1)["indexer"]).toMatchObject({
      errors: ["rate limit exceeded"],
      coolingDown: 1,
    });
    expect(summarizeTick(tick({ ...base, coolingDownUntil: until }), 1)["indexer"]).toMatchObject({ errors: [], coolingDown: 1 });
    expect(summarizeTick(tick(base), 1)["indexer"]).not.toHaveProperty("coolingDown");
  });
});

describe("buildWorker", () => {
  const clients: TestClient[] = [];
  afterEach(async () => {
    while (clients.length) await clients.pop()?.close();
  });

  test("one tick runs the OFAC poll, provisioning, the outbox and the indexer against the database", async () => {
    const { client, db } = await freshDb();
    clients.push(client);
    const unused = new Proxy({} as ChainReader & ChainWriter, {
      get: () => async () => {
        throw new Error("no chain access expected with nothing bound");
      },
    });
    const alerts: FounderAlert[] = [];
    const notifier: Notifier = { notify: async (a) => void alerts.push(a) };
    const worker = buildWorker({
      db,
      reader: unused,
      writer: unused,
      provisioner: localKeyProvisioner({}),
      fetchSdn: async (): Promise<SdnFetchResult> => ({ status: 200, body: SAMPLE }),
      notifier,
    });
    const report = await worker.fullTick(T0);
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
  const clients: TestClient[] = [];
  afterEach(async () => {
    while (clients.length) await clients.pop()?.close();
  });

  test("boots on a valid local env, ticks, and resolves 0 after SIGTERM once the current tick finishes", async () => {
    const { client, db } = await freshDb();
    clients.push(client);
    const handlers = new Map<string, () => void>();
    const lines: string[] = [];
    const done = main(LOCAL_ENV, {
      stderr: (l) => lines.push(l),
      onSignal: (sig, h) => void handlers.set(sig, h),
      db,
      write: (l) => lines.push(l),
    });
    for (let i = 0; i < 200 && !lines.some((l) => l.includes('"event":"tick"')); i++) await wait(25);
    expect(lines.some((l) => l.includes('"event":"tick"'))).toBe(true);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")?.();
    expect(await done).toBe(0);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events[0]).toBe("worker-started");
    // SIGTERM can land mid-pass (a full tick starts every 100 ms here): that in-flight pass may still log its summary
    // after worker-stopping, but no further pass starts.
    expect(events.at(-1)).toBe("worker-stopped");
    const afterStopping = events.slice(events.indexOf("worker-stopping") + 1, -1);
    expect(events).toContain("worker-stopping");
    expect(afterStopping.length).toBeLessThanOrEqual(1);
    expect(afterStopping.every((e) => e === "tick" || e === "fast-pass")).toBe(true);
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
