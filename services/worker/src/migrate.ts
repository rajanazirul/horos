#!/usr/bin/env node
// The `migrate` command (Story 2.10; AD-14, AD-20): Railway runs it as the worker's `preDeployCommand` (the api
// never holds the migrator login; its /healthz stays 503 until the schema catches up). It connects as the
// non-superuser migrator role (`MIGRATOR_DATABASE_URL`), takes
// a session-level advisory lock (polled, with a 5-minute deadline) so concurrent runs apply the migrations one
// after the other, runs the committed migrations, releases the lock and exits 0. Idempotent: a run with nothing
// pending changes nothing. Any failure exits non-zero; the connection string is never printed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectPostgresSession, createLogger, describeEnvFailure, runMigrations, type HorosDb, type Logger, type RawEnv } from "@horos/adapters";
import { parseMigrateEnv } from "./env.js";

/** Fixed `pg_advisory_lock` key for migrations: the ASCII bytes of "horosmig" as a signed 64-bit integer. */
export const MIGRATION_LOCK_KEY = "7525359325362874727";

export interface LockSession {
  readonly db: HorosDb;
  query(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export interface LockOptions {
  /** Give up waiting for the lock after this long. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Delay between `pg_try_advisory_lock` attempts. Default 500 ms. */
  readonly pollMs?: number;
  /** How often to log `migrate-waiting-for-lock` while waiting. Default 10 s. */
  readonly logEveryMs?: number;
  readonly log?: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export const MIGRATE_LOCK_TIMEOUT_MS = 5 * 60_000;

export class MigrationLockTimeoutError extends Error {
  override readonly name = "MigrationLockTimeoutError";
  constructor(readonly waitedMs: number) {
    super(`could not take the migration lock within ${waitedMs} ms (another migrate is still running)`);
  }
}

/**
 * Run every pending migration while holding the migration advisory lock on `session`'s connection. The lock is
 * polled with `pg_try_advisory_lock` until `timeoutMs` (never an unbounded wait). A failing unlock is logged and
 * never replaces the migration's own error; the lock is session-level, so closing the session releases it anyway.
 */
export async function migrateUnderLock(session: LockSession, opts: LockOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? MIGRATE_LOCK_TIMEOUT_MS;
  const logEveryMs = opts.logEveryMs ?? 10_000;
  const started = now();
  let lastLog = started;
  for (;;) {
    const r = await session.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [MIGRATION_LOCK_KEY]);
    if (r.rows[0]?.["locked"] === true) break;
    const waited = now() - started;
    if (waited >= timeoutMs) throw new MigrationLockTimeoutError(waited);
    if (now() - lastLog >= logEveryMs) {
      lastLog = now();
      opts.log?.info({ event: "migrate-waiting-for-lock", waitedMs: waited });
    }
    await sleep(opts.pollMs ?? 500);
  }
  try {
    await runMigrations(session.db);
  } finally {
    try {
      await session.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
    } catch (err) {
      opts.log?.warn({ event: "migrate-unlock-failed", error: err });
    }
  }
}

export interface MigrateIo {
  readonly stderr: (line: string) => void;
  readonly lock?: Omit<LockOptions, "log">;
}

/** Validate the environment, connect, migrate under the lock. Returns the exit code. */
export async function main(raw: RawEnv = process.env, io: MigrateIo = { stderr: (l) => void process.stderr.write(`${l}\n`) }): Promise<number> {
  const parsed = parseMigrateEnv(raw);
  if (!parsed.ok) {
    io.stderr(describeEnvFailure("horos-migrate", parsed.invalid));
    return 1;
  }
  const log = createLogger({ service: "migrate" });
  const started = Date.now();
  let session: Awaited<ReturnType<typeof connectPostgresSession>> | undefined;
  try {
    session = await connectPostgresSession(parsed.env.MIGRATOR_DATABASE_URL);
    await migrateUnderLock(session, { ...io.lock, log });
    log.info({ event: "migrations-applied", durationMs: Date.now() - started });
    return 0;
  } catch (err) {
    log.error({ event: "migrations-failed", error: err });
    return 1;
  } finally {
    await session?.close().catch(() => {});
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
  process.exitCode = await main();
}
