// Test helper: a fresh, migrated in-memory PGlite database. Not exported from the package.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { HorosDb } from "./db.js";
import { runMigrations } from "./migrate.js";

export async function freshDb(): Promise<{ client: PGlite; db: HorosDb }> {
  const client = new PGlite();
  const db = drizzle(client);
  await runMigrations(db);
  return { client, db };
}
