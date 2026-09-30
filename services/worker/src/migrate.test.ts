// The migrate command: migrations run under a fixed advisory lock, idempotently: run twice in sequence on one
// connection, and concurrently as a non-superuser migrator on the test Postgres server.
import { randomBytes } from "node:crypto";
import { emptyDb, testServerUrl, type TestClient } from "@horos/adapters/testing";
import { appliedMigrationCount, connectPostgresSession, createLogger, MIGRATIONS_FOLDER, type HorosDb } from "@horos/adapters";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { main, MIGRATION_LOCK_KEY, migrateUnderLock, MigrationLockTimeoutError, type LockSession } from "./migrate.js";

const MIGRATION_COUNT = (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

describe("migrateUnderLock (one connection, sequential)", () => {
  test("two runs both succeed; the schema is at the latest version and the lock is released", async () => {
    const { client, db } = await emptyDb();
    clients.push(client);
    const session = { db, query: (sql: string, params?: readonly unknown[]) => client.query<Record<string, unknown>>(sql, params === undefined ? undefined : [...params]) };
    await migrateUnderLock(session);
    await migrateUnderLock(session);
    const applied = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
    expect(applied.rows[0]?.n).toBe(MIGRATION_COUNT);
    const locks = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
    expect(locks.rows[0]?.n).toBe(0);
    const grants = await client.query<{ usage: boolean; sel: boolean; del: boolean }>(
      `SELECT has_schema_privilege('horos_app', 'drizzle', 'USAGE') AS usage,
              has_table_privilege('horos_app', 'drizzle.__drizzle_migrations', 'SELECT') AS sel,
              has_table_privilege('horos_app', 'drizzle.__drizzle_migrations', 'DELETE') AS del`,
    );
    expect(grants.rows[0]).toEqual({ usage: true, sel: true, del: false });
  });
});

describe("migrateUnderLock: lock wait and unlock failure", () => {
  function lines() {
    const out: string[] = [];
    return { log: createLogger({ service: "migrate", write: (l) => out.push(l) }), events: () => out.map((l) => (JSON.parse(l) as { event: string }).event) };
  }

  test("a lock held elsewhere is polled, logged every ~10 s, and gives up at the deadline", async () => {
    let t = 0;
    let unlocks = 0;
    const session: LockSession = {
      db: {} as HorosDb,
      query: async (sql) => {
        if (sql.includes("pg_advisory_unlock")) unlocks++;
        return { rows: [{ locked: false }] };
      },
    };
    const { log, events } = lines();
    await expect(
      migrateUnderLock(session, { timeoutMs: 60_000, pollMs: 500, now: () => t, sleep: async (ms) => void (t += ms), log }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    expect(events().filter((e) => e === "migrate-waiting-for-lock")).toHaveLength(5);
    expect(unlocks).toBe(0); // never taken, never released
  });

  test("an unlock failure is logged and does not replace the migration's own error", async () => {
    const session: LockSession = {
      db: {} as HorosDb, // runMigrations fails on this
      query: async (sql) => {
        if (sql.includes("pg_advisory_unlock")) throw new Error("connection terminated during unlock");
        return { rows: [{ locked: true }] };
      },
    };
    const { log, events } = lines();
    const err = await migrateUnderLock(session, { log }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("unlock");
    expect(events()).toContain("migrate-unlock-failed");
  });
});

describe("main", () => {
  test("a missing MIGRATOR_DATABASE_URL exits 1 naming it", async () => {
    const stderr: string[] = [];
    expect(await main({ DATABASE_URL: "postgres://app:secret-pw@h/db" }, { stderr: (l) => stderr.push(l) })).toBe(1);
    expect(stderr.join("\n")).toBe("horos-migrate: invalid environment: MIGRATOR_DATABASE_URL (required)");
  });
});

const REAL_URL = testServerUrl();

describe("migrate (real Postgres, non-superuser migrator, concurrent)", () => {
  const suffix = randomBytes(6).toString("hex");
  const dbName = `horos_migrate_${suffix}`;
  const migrator = `horos_migrator_${suffix}`;
  const appLogin = `horos_api_${suffix}`;
  // Throwaway test-only passwords for throwaway roles.
  const migratorPw = randomBytes(12).toString("hex");
  const appPw = randomBytes(12).toString("hex");
  const urlAs = (user: string, pw: string) => {
    const u = new URL(REAL_URL);
    u.username = user;
    u.password = pw;
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const admin = async <T>(fn: (c: pg.Client) => Promise<T>, database?: string): Promise<T> => {
    const u = new URL(REAL_URL);
    if (database !== undefined) u.pathname = `/${database}`;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    // The runbook's step 2, verbatim in substance: a LOGIN role with CREATE on the database and the public schema
    // only, and horos_app pre-created so 0000's DO block skips CREATE ROLE.
    await admin(async (c) => {
      await c.query(`CREATE DATABASE ${dbName}`);
      await c.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${migratorPw}'`);
      await c.query(`GRANT CREATE ON DATABASE ${dbName} TO ${migrator}`);
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'horos_app') THEN CREATE ROLE horos_app NOLOGIN; END IF; END $$`).catch(() => {});
      await c.query(`CREATE ROLE ${appLogin} LOGIN PASSWORD '${appPw}' IN ROLE horos_app`);
    });
    await admin((c) => c.query(`GRANT CREATE ON SCHEMA public TO ${migrator}`), dbName);
  });
  afterAll(async () => {
    await admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${appLogin}`);
      await c.query(`DROP ROLE IF EXISTS ${migrator}`);
    });
  });

  test("two concurrent runs as the non-superuser migrator both exit 0; the app login then works", async () => {
    const stderr: string[] = [];
    const io = { stderr: (l: string) => stderr.push(l) };
    const url = urlAs(migrator, migratorPw);
    const codes = await Promise.all([main({ MIGRATOR_DATABASE_URL: url }, io), main({ MIGRATOR_DATABASE_URL: url }, io)]);
    expect(codes).toEqual([0, 0]);
    expect(stderr).toEqual([]);
    const super_ = await admin((c) => c.query<{ s: boolean }>(`SELECT rolsuper AS s FROM pg_roles WHERE rolname = $1`, [migrator]));
    expect(super_.rows[0]?.s).toBe(false);

    const app = await connectPostgresSession(urlAs(appLogin, appPw));
    try {
      expect(await appliedMigrationCount(app.db)).toBe(MIGRATION_COUNT); // 0006: the app role reads the journal
      const r = await app.query("SELECT current_user AS u, count(*)::int AS n FROM policy_version");
      expect(r.rows[0]?.["u"]).toBe(appLogin);
      await expect(app.query("DELETE FROM drizzle.__drizzle_migrations")).rejects.toThrow(/permission denied/);
      await expect(app.query("DELETE FROM decision_record")).rejects.toThrow(/permission denied/);
      const locks = await app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
      expect(locks.rows[0]?.["n"]).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("while another session holds the lock, main waits, then exits 1 at its deadline", async () => {
    const holder = new pg.Client({ connectionString: urlAs(migrator, migratorPw) });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
      const stderr: string[] = [];
      const code = await main({ MIGRATOR_DATABASE_URL: urlAs(migrator, migratorPw) }, { stderr: (l) => stderr.push(l), lock: { timeoutMs: 1_500, pollMs: 100 } });
      expect(code).toBe(1);
    } finally {
      await holder.end();
    }
  });
});
