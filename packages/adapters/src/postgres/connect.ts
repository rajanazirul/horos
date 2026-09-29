// node-postgres connection for the services. The connection string comes from validated env, never code.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { HorosDb } from "./db.js";

export interface PostgresConnection {
  readonly db: HorosDb;
  close(): Promise<void>;
}

/**
 * An idle pooled client can emit `error` (e.g. a database restart). Without a listener Node treats it as
 * uncaught and crashes; the pool already discards the broken client, so the error is forwarded (never thrown).
 * `onError` must not log connection strings or other secrets.
 */
export function connectPostgres(
  connectionString: string,
  maxConnections = 10,
  onError: (err: Error) => void = () => {},
): PostgresConnection & { readonly pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: maxConnections });
  pool.on("error", (err) => {
    try {
      onError(err);
    } catch {
      // A failing handler must not turn a recoverable idle-client error into a crash.
    }
  });
  return { db: drizzle(pool), pool, close: () => pool.end() };
}

/** One dedicated connection (not a pool): session-level state such as advisory locks stays on it. */
export interface PostgresSession {
  readonly db: HorosDb;
  query(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  close(): Promise<void>;
}

/** Open a single-connection session (the migrate entry point uses it to hold `pg_advisory_lock`). */
export async function connectPostgresSession(connectionString: string): Promise<PostgresSession> {
  const client = new pg.Client({ connectionString });
  // A dropped connection must reject the pending query, not crash the process with an unhandled 'error'.
  client.on("error", () => {});
  await client.connect();
  return {
    db: drizzle(client),
    query: async (sql, params) => client.query(sql, params === undefined ? undefined : [...params]),
    close: () => client.end(),
  };
}

/**
 * `SELECT 1` (the health check). Resolves false on an error or after `timeoutMs`; never rejects. The ping runs in a
 * transaction with `SET LOCAL statement_timeout` equal to the budget, so a slow server cancels it and the pooled
 * client is released instead of being held by repeated health polls.
 */
export async function pingPostgres(db: HorosDb, timeoutMs = 2_000): Promise<boolean> {
  const budget = Math.max(1, Math.floor(timeoutMs));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), budget);
  });
  const ping = db
    .transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${budget}`));
      await tx.execute(sql`select 1`);
    })
    .then(
      () => true,
      () => false,
    );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
