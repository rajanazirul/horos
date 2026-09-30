#!/usr/bin/env node
// The worker entry point (Story 2.10; AD-8, AD-15, AD-20, AD-24). Thin wiring only: validate the environment,
// build the job, list, record, outbox and indexer stores, the OFAC fetcher, the founder-alert webhook, key
// provisioning, the chain reader and writer, and load the Horos Demo List; then run one sequential loop (AD-20,
// amended 2026-09-29) that wakes every FAST_TICK_MS and runs `fullTick(now)` when TICK_INTERVAL_MS has elapsed since
// the last full tick, otherwise `fastPass(now)`. Passes never overlap (the next one starts only after the previous
// one finished and the rest of the wake interval elapsed). Each full tick, and each fast pass that did something,
// logs one structured JSON summary. SIGTERM/SIGINT stop the loop after the current pass, then the pool closes. A
// pass running past MAX_TICK_MS is logged, alerted and exits 1 (Railway restarts on failure). Runs as a single
// replica (one serialized lane per signing key, AD-8).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARC_TESTNET_MIN_BASE_FEE_WEI,
  ARC_TESTNET_USDC,
  chainConfig,
  circleClientFromSdk,
  CircleChainWriter,
  CircleKeyProvisioner,
  connectPostgres,
  createLogger,
  describeEnvFailure,
  httpSdnFetcher,
  loadActiveListSnapshots,
  loadDemoList,
  LocalKeyChainWriter,
  localKeyProvisioner,
  PostgresAccountStore,
  PostgresIndexerStore,
  PostgresJobStore,
  PostgresListStore,
  PostgresOutboxStore,
  PostgresRecordStore,
  uuidv7,
  ViemChainReader,
  WebhookNotifier,
  type ChainConfig,
  type FetchSdn,
  type HorosDb,
  type Logger,
  type RawEnv,
} from "@horos/adapters";
import type { ChainReader, ChainWriter, KeyProvisioner, Notifier } from "@horos/core";
import { parseWorkerEnv, type WorkerEnv } from "./env.js";
import type { IndexerDeps, WalletIndexReport } from "./indexer.js";
import { createWorker, type FastPassReport, type TickReport, type Worker, type WorkerDeps } from "./tick.js";

export interface WorkerRuntime {
  readonly db: HorosDb;
  readonly reader: ChainReader;
  readonly writer: ChainWriter;
  readonly provisioner: KeyProvisioner;
  readonly fetchSdn: FetchSdn;
  readonly notifier: Notifier;
}

export function chainConfigFrom(env: WorkerEnv): ChainConfig {
  return chainConfig({
    chainId: env.CHAIN_ID,
    rpcUrls: [env.ARC_RPC_PRIMARY, env.ARC_RPC_SECONDARY],
    usdc: ARC_TESTNET_USDC,
    minBaseFeeWei: ARC_TESTNET_MIN_BASE_FEE_WEI,
  });
}

/** The vendor adapters for `env` (Circle or local-key writes, viem reads, the SDN fetcher, the alert webhook). */
export function vendorRuntime(env: WorkerEnv): Omit<WorkerRuntime, "db"> {
  const config = chainConfigFrom(env);
  const cw = env.chainWriter;
  let writer: ChainWriter;
  let provisioner: KeyProvisioner;
  if (cw.kind === "circle") {
    const client = circleClientFromSdk({ apiKey: cw.apiKey, entitySecret: cw.entitySecret });
    writer = new CircleChainWriter(client);
    provisioner = new CircleKeyProvisioner(client);
  } else {
    writer = new LocalKeyChainWriter(config, Object.values(cw.keys));
    provisioner = localKeyProvisioner(cw.keys);
  }
  return {
    reader: new ViemChainReader(config),
    writer,
    provisioner,
    fetchSdn: httpSdnFetcher({ url: env.OFAC_SDN_URL }),
    notifier: new WebhookNotifier({ url: env.FOUNDER_ALERT_WEBHOOK_URL }),
  };
}

/** Wire `createWorker` with every job: OFAC poll, key provisioning, the outbox sender and the indexer. */
export function buildWorker(
  rt: WorkerRuntime,
  cadences?: WorkerDeps["cadences"],
  indexerLimits?: Pick<IndexerDeps, "maxChunksPerTick" | "rateLimitCooldownMs">,
): Worker {
  const { db, reader, writer, notifier } = rt;
  const jobs = new PostgresJobStore(db);
  const lists = new PostgresListStore(db);
  const accounts = new PostgresAccountStore(db);
  const records = new PostgresRecordStore(db);
  return createWorker({
    jobs,
    lists,
    fetchSdn: rt.fetchSdn,
    notifier,
    newId: () => uuidv7(),
    provisioning: { accounts, provisioner: rt.provisioner },
    outbox: {
      accounts,
      outbox: new PostgresOutboxStore(db),
      records,
      reader,
      writer,
      notifier,
      loadLists: () => loadActiveListSnapshots(lists),
      newId: uuidv7,
    },
    indexer: { store: new PostgresIndexerStore(db), jobs, records, reader, notifier, newId: uuidv7, ...indexerLimits },
    ...(cadences === undefined ? {} : { cadences }),
  });
}

/** A secret-free, count-level summary of one tick for the log. */
export function summarizeTick(report: TickReport, durationMs: number): Record<string, unknown> {
  const ofac = !report.ran
    ? { window: report.window, ran: false }
    : "error" in report
      ? { window: report.window, ran: true, error: report.error }
      : { window: report.window, ran: true, outcome: report.outcome.kind };
  const count = <T extends { kind: string }>(xs: readonly T[]) => {
    const out: Record<string, number> = {};
    for (const x of xs) out[x.kind] = (out[x.kind] ?? 0) + 1;
    return out;
  };
  return {
    event: "tick",
    durationMs,
    ofac,
    ...(report.provision === undefined
      ? {}
      : { provision: { provisioned: report.provision.provisioned.length, failed: report.provision.failed.map((f) => f.error) } }),
    ...(report.outbox === undefined
      ? {}
      : { outbox: { recovered: report.outbox.recovered, polled: count(report.outbox.polled), processed: count(report.outbox.processed) } }),
    ...(report.indexer === undefined
      ? {}
      : {
          indexer: {
            wallets: report.indexer.wallets.length,
            chunks: report.indexer.wallets.reduce((n, w) => n + w.chunks, 0),
            confirmed: report.indexer.wallets.reduce((n, w) => n + w.confirmed, 0),
            external: report.indexer.wallets.reduce((n, w) => n + w.external, 0),
            paid: report.indexer.wallets.reduce((n, w) => n + w.paid, 0),
            errors: report.indexer.wallets.flatMap((w) => (w.error === undefined ? [] : [w.error])),
            ...coolingDown(report.indexer.wallets),
            reconciled: report.indexer.reconciled,
            ...(report.indexer.reconcileError === undefined ? {} : { reconcileError: report.indexer.reconcileError }),
            alertsDelivered: report.indexer.alertsDelivered.length,
            alertErrors: report.indexer.alertErrors.length,
          },
        }),
  };
}

/** Wallets cooling down after a rate limit (the error is in `errors` only on the pass that started the cooldown). */
function coolingDown(wallets: readonly WalletIndexReport[]): { coolingDown?: number } {
  const n = wallets.filter((w) => w.coolingDownUntil !== undefined).length;
  return n === 0 ? {} : { coolingDown: n };
}

/** A wallet the pass skipped because it is cooling down (no chain call). */
const skipped = (w: WalletIndexReport) => w.coolingDownUntil !== undefined && w.error === undefined;

/** A secret-free, count-level summary of one fast pass, or undefined when it did nothing (not logged). */
export function summarizeFastPass(report: FastPassReport, durationMs: number): Record<string, unknown> | undefined {
  const polled = report.outbox?.polled ?? [];
  const processed = report.outbox?.processed ?? [];
  // A pass that only skipped cooling-down wallets did nothing (not logged every in-flight index pass).
  const wallets = (report.indexer?.wallets ?? []).filter((w) => !skipped(w));
  if (polled.length === 0 && processed.length === 0 && wallets.length === 0) return undefined;
  const count = <T extends { kind: string }>(xs: readonly T[]) => {
    const out: Record<string, number> = {};
    for (const x of xs) out[x.kind] = (out[x.kind] ?? 0) + 1;
    return out;
  };
  return {
    event: "fast-pass",
    durationMs,
    ...(polled.length === 0 && processed.length === 0 ? {} : { outbox: { polled: count(polled), processed: count(processed) } }),
    ...(wallets.length === 0
      ? {}
      : {
          indexer: {
            wallets: wallets.length,
            confirmed: wallets.reduce((n, w) => n + w.confirmed, 0),
            errors: wallets.flatMap((w) => (w.error === undefined ? [] : [w.error])),
            ...coolingDown(wallets),
          },
        }),
  };
}

export interface LoopOptions {
  readonly fullTick: (now: Date) => Promise<TickReport>;
  readonly fastPass: (now: Date) => Promise<FastPassReport>;
  /** The wake interval (FAST_TICK_MS). */
  readonly fastIntervalMs: number;
  /** A wake at least this long after the last full tick's start runs a full tick (TICK_INTERVAL_MS). */
  readonly fullIntervalMs: number;
  /** A pass still running after this long is presumed hung (an RPC, Circle or webhook call without a timeout). */
  readonly maxTickMs: number;
  /** Best-effort founder alert on a hung tick; bounded by `alertTimeoutMs`. */
  readonly onTickTimeout?: () => Promise<void>;
  /** Default 10 s. */
  readonly alertTimeoutMs?: number;
  /** Aborting stops the loop once the current tick (if any) has finished. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** Why the loop ended: a stop signal, or a hung tick (the caller exits 1 so the platform restarts the worker). */
export type LoopExit = "stopped" | "tick-timeout";

const TIMED_OUT = Symbol("timed-out");

/** `p`'s value, or TIMED_OUT after `ms`. */
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve after `ms`, or at once when `signal` aborts. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * One sequential loop (AD-8, AD-20): wake every `fastIntervalMs` and run `fullTick` when `fullIntervalMs` has elapsed
 * since the last full tick started (the first wake is always full), otherwise `fastPass`. One pass at a time: a pass
 * that overruns the wake interval delays the next one instead of overlapping it. A failing pass is logged and the
 * loop continues. Resolves `"stopped"` once `signal` aborts and the in-flight pass has finished. A pass still
 * running after `maxTickMs` is logged (`tick-timeout`), alerted (best-effort, bounded) and ends the loop with
 * `"tick-timeout"`: no further pass starts, so the hung one can never overlap another.
 */
export async function runLoop(opts: LoopOptions): Promise<LoopExit> {
  const now = opts.now ?? (() => new Date());
  let lastFull: number | undefined;
  while (!opts.signal.aborted) {
    const started = now();
    const full = lastFull === undefined || started.getTime() - lastFull >= opts.fullIntervalMs;
    if (full) lastFull = started.getTime();
    const pass = full ? "full" : "fast";
    try {
      // Resolves to the pass's log summary (undefined: a fast pass that did nothing, not logged).
      type Summarize = (durationMs: number) => Record<string, unknown> | undefined;
      const work: Promise<Summarize> = full
        ? opts.fullTick(started).then((r) => (ms: number) => summarizeTick(r, ms))
        : opts.fastPass(started).then((r) => (ms: number) => summarizeFastPass(r, ms));
      const summarize = await raceTimeout(work, opts.maxTickMs);
      if (summarize === TIMED_OUT) {
        opts.log.error({ event: "tick-timeout", pass, maxTickMs: opts.maxTickMs, startedAt: started });
        if (opts.onTickTimeout !== undefined) {
          const alerted = await raceTimeout(
            opts.onTickTimeout().then(
              () => true,
              (err: unknown) => (opts.log.warn({ event: "tick-timeout-alert-failed", error: err }), false),
            ),
            opts.alertTimeoutMs ?? 10_000,
          );
          if (alerted === TIMED_OUT) opts.log.warn({ event: "tick-timeout-alert-failed", error: "alert timed out" });
        }
        return "tick-timeout";
      }
      const summary = summarize(now().getTime() - started.getTime());
      if (summary !== undefined) opts.log.info(summary);
    } catch (err) {
      opts.log.error({ event: "tick-failed", pass, durationMs: now().getTime() - started.getTime(), error: err });
    }
    await sleepUnlessAborted(opts.fastIntervalMs - (now().getTime() - started.getTime()), opts.signal);
  }
  return "stopped";
}

export interface MainIo {
  readonly stderr: (line: string) => void;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Test seams: the database and vendors (default: from the environment) and the log sink (default stdout). */
  readonly db?: HorosDb;
  readonly vendors?: (env: WorkerEnv) => Omit<WorkerRuntime, "db">;
  readonly write?: (line: string) => void;
}

/** How long the pool gets to close on the way out (a hung tick may still hold a client). */
const CLOSE_DEADLINE_MS = 5_000;

const processIo: MainIo = {
  stderr: (line) => void process.stderr.write(`${line}\n`),
  onSignal: (signal, handler) => void process.once(signal, handler),
};

/** Validate the environment (exit code 1 naming the invalid variables), then loop until SIGTERM/SIGINT. */
export async function main(raw: RawEnv = process.env, io: MainIo = processIo): Promise<number> {
  const parsed = parseWorkerEnv(raw);
  if (!parsed.ok) {
    io.stderr(describeEnvFailure("horos-worker", parsed.invalid));
    return 1;
  }
  const env = parsed.env;
  const log = createLogger({
    service: "worker",
    ...(env.LOG_LEVEL === undefined ? {} : { level: env.LOG_LEVEL }),
    ...(io.write === undefined ? {} : { write: io.write }),
  });
  const conn =
    io.db === undefined ? connectPostgres(env.DATABASE_URL, 5, (err) => log.warn({ event: "pg-idle-client-error", error: err })) : undefined;
  const db = io.db ?? (conn as NonNullable<typeof conn>).db;
  try {
    const lists = new PostgresListStore(db);
    const demo = await loadDemoList(lists, { now: new Date(), newId: () => uuidv7() });
    const vendors = (io.vendors ?? vendorRuntime)(env);
    const worker = buildWorker(
      { db, ...vendors },
      { circleStatusPollMs: env.CIRCLE_STATUS_POLL_MS, inflightIndexMs: env.INFLIGHT_INDEX_MS },
      { maxChunksPerTick: env.INDEXER_MAX_CHUNKS_PER_TICK, rateLimitCooldownMs: env.INDEXER_RATE_LIMIT_COOLDOWN_MS },
    );
    const stop = new AbortController();
    const onStop = () => {
      log.info({ event: "worker-stopping" });
      stop.abort();
    };
    io.onSignal("SIGTERM", onStop);
    io.onSignal("SIGINT", onStop);
    log.info({
      event: "worker-started",
      chainId: env.CHAIN_ID,
      chainWriter: env.chainWriter.kind,
      tickIntervalMs: env.TICK_INTERVAL_MS,
      fastTickMs: env.FAST_TICK_MS,
      circleStatusPollMs: env.CIRCLE_STATUS_POLL_MS,
      inflightIndexMs: env.INFLIGHT_INDEX_MS,
      indexerMaxChunksPerTick: env.INDEXER_MAX_CHUNKS_PER_TICK,
      indexerRateLimitCooldownMs: env.INDEXER_RATE_LIMIT_COOLDOWN_MS,
      demoListSnapshot: demo.snapshotId,
    });
    const exit = await runLoop({
      fullTick: (now) => worker.fullTick(now),
      fastPass: (now) => worker.fastPass(now),
      fastIntervalMs: env.FAST_TICK_MS,
      fullIntervalMs: env.TICK_INTERVAL_MS,
      maxTickMs: env.MAX_TICK_MS,
      onTickTimeout: () =>
        vendors.notifier.notify({
          kind: "worker-tick-timeout",
          maxTickMs: env.MAX_TICK_MS,
          message: `A worker pass ran longer than ${env.MAX_TICK_MS} ms; the worker is exiting so Railway restarts it.`,
        }),
      signal: stop.signal,
      log,
    });
    if (exit === "tick-timeout") return 1;
    log.info({ event: "worker-stopped" });
    return 0;
  } catch (err) {
    log.error({ event: "worker-failed", error: err });
    return 1;
  } finally {
    if (conn !== undefined) await raceTimeout(conn.close().catch(() => {}), CLOSE_DEADLINE_MS);
  }
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  // Exit explicitly: after a tick timeout the hung call may still hold sockets that would keep the process alive.
  process.exit(await main());
}
