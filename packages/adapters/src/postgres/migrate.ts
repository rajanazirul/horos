// Runs the committed SQL migrations as the connecting (migrator) role. Never `drizzle-kit push`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { HorosDb } from "./db.js";

/** Absolute path of the committed migrations folder (`packages/adapters/drizzle`). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Apply every pending migration on a node-postgres handle.
 */
export async function runMigrations(db: HorosDb): Promise<void> {
  await migrate(db as unknown as NodePgDatabase, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** How many migrations this build bundles (entries in the committed drizzle journal). */
export function bundledMigrationCount(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  return journal.entries.length;
}

/**
 * How many migrations the database has applied (rows in `drizzle.__drizzle_migrations`); 0 when the table does not
 * exist yet. The app role can read it (migration 0006).
 */
export async function appliedMigrationCount(db: HorosDb): Promise<number> {
  // node-postgres results carry `rows`.
  type Rows<T> = { readonly rows: readonly T[] };
  const exists = (await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`)) as unknown as Rows<{ t: string | null }>;
  if (exists.rows[0]?.t == null) return 0;
  const r = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as Rows<{ n: number }>;
  return Number(r.rows[0]?.n ?? 0);
}
