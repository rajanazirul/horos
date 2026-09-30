// Test helper: throwaway databases on a real Postgres server (the `postgres-test` service in docker-compose.yml, or
// the CI service container). The first call in a process builds a migrated template database, keyed by a hash of the
// committed migrations; each test then gets its own `CREATE DATABASE ... TEMPLATE` copy, which is far cheaper than
// migrating. Test-only: exported as `@horos/adapters/testing`, never from the package root.
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { HorosDb } from "./db.js";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";

/** Matches the `postgres-test` service in docker-compose.yml. CI sets its own. */
const DEFAULT_URL = "postgres://postgres:horos-test@127.0.0.1:54329/postgres";
// Serialises template builds and cluster-wide role creation across vitest workers and packages.
const SETUP_LOCK_KEY = "7525359325362874801";

/** The admin connection string (a superuser on a disposable server). */
export function testServerUrl(): string {
  const v = process.env["HOROS_TEST_DATABASE_URL"];
  return v === undefined || v === "" ? DEFAULT_URL : v;
}

/** `testServerUrl()` pointed at database `name`. */
export function testDatabaseUrl(name: string): string {
  const url = new URL(testServerUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * One connection to a test database, with PGlite's shape so tests keep `client.query` / `client.exec`. The pool is
 * capped at one connection that is never released, so session state (`SET ROLE`) persists and queries serialise,
 * as they did on PGlite. `close()` drops the database.
 */
export interface TestClient {
  readonly name: string;
  readonly url: string;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  /** Idempotent. */
  close(): Promise<void>;
}

let admin: pg.Pool | undefined;
function adminPool(): pg.Pool {
  admin ??= new pg.Pool({ connectionString: testServerUrl(), max: 2, allowExitOnIdle: true });
  return admin;
}

/** Rethrows a refused connection with the command that starts the test server. */
function explainUnreachable(err: unknown): never {
  const code = (err as { code?: string }).code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
    throw new Error(`test Postgres is not reachable at ${new URL(testServerUrl()).host}: run \`docker compose up -d postgres-test\``, { cause: err });
  }
  throw err;
}

async function adminQuery(sql: string): Promise<void> {
  await adminPool().query(sql).catch(explainUnreachable);
}

function migrationsHash(): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else h.update(entry.name).update(readFileSync(p));
    }
  };
  walk(MIGRATIONS_FOLDER);
  return h.digest("hex").slice(0, 16);
}

let template: Promise<string> | undefined;

/** Name of the migrated template database, built on first use (one build per migration set, across processes). */
function migratedTemplate(): Promise<string> {
  template ??= (async () => {
    const name = `horos_tpl_${migrationsHash()}`;
    const building = `${name}_building`;
    const c = await adminPool().connect().catch(explainUnreachable);
    try {
      await c.query("SELECT pg_advisory_lock($1::bigint)", [SETUP_LOCK_KEY]);
      // horos_app is cluster-wide; creating it here (not in each migration run) avoids a race between databases.
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'horos_app') THEN CREATE ROLE horos_app NOLOGIN; END IF; END $$`);
      // Databases left behind by killed test processes: drop any over an hour old (their files' mtime; missing_ok
      // because a concurrent test may drop a database between the listing and the stat).
      const stale = await c.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE (datname LIKE 'horos\\_t\\_%' OR datname LIKE 'horos\\_s\\_%')
           AND (pg_stat_file('base/' || oid || '/PG_VERSION', true)).modification < now() - interval '1 hour'`,
      );
      for (const r of stale.rows) await c.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
      const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount === 0) {
        // A crashed build leaves `_building` behind; only a finished template is renamed to `name`.
        await c.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
        await c.query(`CREATE DATABASE ${building}`);
        const pool = new pg.Pool({ connectionString: testDatabaseUrl(building), max: 1 });
        try {
          await runMigrations(drizzle(pool) as unknown as HorosDb);
        } finally {
          await pool.end();
        }
        await c.query(`ALTER DATABASE ${building} RENAME TO ${name}`);
      }
      return name;
    } finally {
      await c.query("SELECT pg_advisory_unlock($1::bigint)", [SETUP_LOCK_KEY]).catch(() => {});
      c.release();
    }
  })();
  template.catch(() => {
    template = undefined;
  });
  return template;
}

/**
 * A one-connection pool whose `query` keeps the connection after an error. `pg.Pool.query` destroys the connection
 * whenever a query fails, which would silently drop session state such as `SET ROLE` mid-test.
 */
function oneConnectionPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 1, idleTimeoutMillis: 0, allowExitOnIdle: true });
  pool.on("error", () => {});
  const query = async (...args: unknown[]): Promise<pg.QueryResult> => {
    const c = await pool.connect();
    try {
      return await (c.query as (...a: unknown[]) => Promise<pg.QueryResult>)(...args);
    } finally {
      c.release();
    }
  };
  pool.query = query as typeof pool.query;
  return pool;
}

async function createDb(from: string | undefined): Promise<{ client: TestClient; db: HorosDb }> {
  const name = `horos_t_${randomBytes(8).toString("hex")}`;
  await adminQuery(from === undefined ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} TEMPLATE ${from}`);
  const url = testDatabaseUrl(name);
  const pool = oneConnectionPool(url);
  let closed = false;
  const client: TestClient = {
    name,
    url,
    query: async <T>(sql: string, params?: readonly unknown[]) => {
      const r = await pool.query(sql, params === undefined ? undefined : [...params]);
      return { rows: r.rows as T[] };
    },
    exec: async (sql: string) => {
      await pool.query(sql);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
      await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
  return { client, db: drizzle(pool) as unknown as HorosDb };
}

/** A fresh database with every committed migration applied. */
export async function freshDb(): Promise<{ client: TestClient; db: HorosDb }> {
  return createDb(await migratedTemplate());
}

/** A fresh, empty database (no migrations), for tests of the migrations themselves. */
export async function emptyDb(): Promise<{ client: TestClient; db: HorosDb }> {
  await migratedTemplate(); // creates horos_app under the setup lock, so concurrent migration runs never race on it
  return createDb(undefined);
}

/** A seeded template database: each `fresh()` is a copy of it. */
export interface DbTemplate {
  readonly name: string;
  fresh(): Promise<{ client: TestClient; db: HorosDb }>;
  drop(): Promise<void>;
}

/**
 * Migrate, run `seed` once, and keep the result as a template, for test files whose every test starts from the same
 * rows. Call `drop()` from `afterAll` when convenient; an undropped template is swept after an hour.
 */
export async function seededTemplate(seed: (db: HorosDb) => Promise<void>): Promise<DbTemplate> {
  const name = `horos_s_${randomBytes(8).toString("hex")}`;
  await adminQuery(`CREATE DATABASE ${name} TEMPLATE ${await migratedTemplate()}`);
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(name), max: 1 });
  try {
    await seed(drizzle(pool) as unknown as HorosDb);
  } finally {
    await pool.end();
  }
  return {
    name,
    fresh: () => createDb(name),
    drop: () => adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}
