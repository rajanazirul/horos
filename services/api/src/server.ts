#!/usr/bin/env node
// The api entry point (Story 2.10; AD-15, AD-20). Thin wiring only: validate the environment, build the
// Postgres and viem adapters, mount every route through `createApp`, add `GET /healthz`, and serve on PORT.
// `/healthz` answers 503 while the database is unreachable or its schema is behind this build's migrations (the
// worker's pre-deploy step migrates; the api never holds the migrator login). An invalid environment prints the
// invalid variable names (never values) and exits 1. SIGTERM/SIGINT stop accepting connections and close the pool,
// once, with a 10 s deadline after which the process exits 1 regardless.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serve, type ServerType } from "@hono/node-server";
import {
  ARC_TESTNET_MIN_BASE_FEE_WEI,
  ARC_TESTNET_USDC,
  chainConfig,
  connectPostgres,
  createLogger,
  describeEnvFailure,
  PostgresAccountStore,
  PostgresPolicyVersionStore,
  PostgresReadStore,
  pingPostgres,
  appliedMigrationCount,
  bundledMigrationCount,
  cachedChainReader,
  uuidv7,
  ViemChainReader,
  type HorosDb,
  type Logger,
  type RawEnv,
} from "@horos/adapters";
import type { ChainReader } from "@horos/core";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { postgresCheckDeps } from "./check.js";
import { parseApiEnv, type ApiEnv } from "./env.js";

/** Each `/healthz` database step (ping, migration count) gets this long. */
const HEALTH_BUDGET_MS = 2_000;

/** `p`'s value, or undefined when it rejects or takes longer than `ms`. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiRuntime {
  readonly db: HorosDb;
  readonly chainReader: ChainReader;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** Every route (`createApp`) plus `GET /healthz`. Unhandled errors are logged redacted and answered 500 `internal`. */
export function buildApiApp(env: ApiEnv, rt: ApiRuntime): Hono {
  const now = rt.now ?? (() => new Date());
  const log = (entry: Record<string, unknown>) => rt.log.info(entry);
  // The Check path reads `policy` and `roles` from a short-lived per-wallet cache (CHAIN_READ_CACHE_MS) so a burst
  // of Checks does not re-read them; `remaining` stays live (AD-3). Signed-Check auth compares the signer against
  // the cached Payment role holder, so a Payment-key rotation takes effect within that TTL.
  const checkReader = cachedChainReader(rt.chainReader, { ttlMs: env.CHAIN_READ_CACHE_MS });
  const app = createApp({
    policyVersions: new PostgresPolicyVersionStore(rt.db),
    adminToken: env.ADMIN_TOKEN,
    now,
    newId: () => uuidv7(now().getTime()),
    accounts: new PostgresAccountStore(rt.db),
    chainReader: rt.chainReader,
    chainId: env.CHAIN_ID,
    reads: new PostgresReadStore(rt.db),
    ...(env.PUBLIC_DEMO_SCOPE === undefined ? {} : { publicDemoScope: env.PUBLIC_DEMO_SCOPE }),
    log,
    logError: (entry) => rt.log.error(entry),
    check: postgresCheckDeps(rt.db, { chainReader: checkReader, chainId: env.CHAIN_ID, now, log }),
    ...(env.CHECK_RATE_PER_MINUTE === undefined ? {} : { checkRatePerMinute: env.CHECK_RATE_PER_MINUTE }),
    remoteAddress: (c) => {
      try {
        return getConnInfo(c).remote.address;
      } catch {
        return undefined;
      }
    },
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
  });
  const bundled = bundledMigrationCount();
  app.get("/healthz", async (c) => {
    if (!(await pingPostgres(rt.db, HEALTH_BUDGET_MS))) return c.json({ status: "unavailable", db: "unreachable" }, 503);
    const applied = await withDeadline(appliedMigrationCount(rt.db), HEALTH_BUDGET_MS);
    if (applied === undefined) return c.json({ status: "unavailable", db: "unreachable" }, 503);
    const migrations = { applied, bundled };
    // Behind: this build expects migrations the worker has not applied yet. Ahead is healthy: migrations are
    // additive and forward-only, so a rolled-back image runs on a newer schema.
    if (applied < bundled) return c.json({ status: "schema-behind", db: "ok", migrations }, 503);
    return c.json({ status: "ok", db: "ok", migrations }, 200);
  });
  return app;
}

export interface RunningApi {
  readonly port: number;
  close(): Promise<void>;
}

/** Serve `app` on `port` (0 = any free port). Resolves once listening; rejects on a bind error (e.g. EADDRINUSE). */
export function listen(app: Hono, port: number): Promise<{ readonly server: ServerType; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port }, (info) => {
      server.off("error", reject);
      resolve({ server, port: info.port });
    });
    server.once("error", reject);
  });
}

/** Connect, build and serve. Used by `main` and the boot smoke test. */
export async function startApi(env: ApiEnv, overrides: Partial<ApiRuntime> & { readonly port?: number } = {}): Promise<RunningApi> {
  const log = overrides.log ?? createLogger({ service: "api", ...(env.LOG_LEVEL === undefined ? {} : { level: env.LOG_LEVEL }) });
  const conn =
    overrides.db === undefined
      ? connectPostgres(env.DATABASE_URL, 10, (err) => log.warn({ event: "pg-idle-client-error", error: err }))
      : undefined;
  const db = overrides.db ?? (conn as NonNullable<typeof conn>).db;
  const chainReader =
    overrides.chainReader ??
    new ViemChainReader(
      chainConfig({
        chainId: env.CHAIN_ID,
        rpcUrls: [env.ARC_RPC_PRIMARY, env.ARC_RPC_SECONDARY],
        usdc: ARC_TESTNET_USDC,
        minBaseFeeWei: ARC_TESTNET_MIN_BASE_FEE_WEI,
      }),
    );
  const app = buildApiApp(env, { db, chainReader, log, ...(overrides.now === undefined ? {} : { now: overrides.now }) });
  const { server, port } = await listen(app, overrides.port ?? env.PORT);
  log.info({ event: "api-listening", port, chainId: env.CHAIN_ID, publicDemoScope: env.PUBLIC_DEMO_SCOPE ?? null });
  let closing: Promise<void> | undefined;
  return {
    port,
    // Idempotent: a second call (a repeated signal) returns the same shutdown.
    close: () =>
      (closing ??= (async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await conn?.close();
      })()),
  };
}

/** After the first stop signal, the process exits 1 if shutdown has not finished within this long. */
export const SHUTDOWN_DEADLINE_MS = 10_000;

export interface MainIo {
  readonly stderr: (line: string) => void;
  readonly exit: (code: number) => void;
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Test seam: how to start the server. Default `startApi`. */
  readonly start?: (env: ApiEnv) => Promise<RunningApi>;
  readonly shutdownDeadlineMs?: number;
}

const processIo: MainIo = {
  stderr: (line) => void process.stderr.write(`${line}\n`),
  exit: (code) => process.exit(code),
  onSignal: (signal, handler) => void process.once(signal, handler),
};

/** Validate the environment (exit 1 naming the invalid variables), then serve until SIGTERM/SIGINT. */
export async function main(raw: RawEnv = process.env, io: MainIo = processIo): Promise<RunningApi | undefined> {
  const parsed = parseApiEnv(raw);
  if (!parsed.ok) {
    io.stderr(describeEnvFailure("horos-api", parsed.invalid));
    io.exit(1);
    return undefined;
  }
  const running = await (io.start ?? startApi)(parsed.env);
  let stopping = false;
  const stop = () => {
    if (stopping) return; // SIGTERM then SIGINT (or a repeat) runs the shutdown once
    stopping = true;
    const deadline = setTimeout(() => io.exit(1), io.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void running.close().then(
      () => {
        clearTimeout(deadline);
        io.exit(0);
      },
      () => {
        clearTimeout(deadline);
        io.exit(1);
      },
    );
  };
  io.onSignal("SIGTERM", stop);
  io.onSignal("SIGINT", stop);
  return running;
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
  main().catch((err: unknown) => {
    createLogger({ service: "api" }).error({ event: "boot-failed", error: err });
    process.exit(1);
  });
}
