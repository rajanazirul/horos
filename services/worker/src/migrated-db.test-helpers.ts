// Test helper: PGlite databases that start migrated. Migrations run once per test file (module scope); each test
// loads its own copy from the dump, which is far cheaper than migrating and keeps PGlite tests inside their timeout
// under full-repo parallel load. Test-only; excluded from the build.
import { PGlite } from "@electric-sql/pglite";
import { runMigrations, type HorosDb } from "@horos/adapters";
import { drizzle } from "drizzle-orm/pglite";

let dump: Promise<Blob> | undefined;

/** The migrated template's data directory (created on first use; call from `beforeAll` to pay for it there). */
export function migratedDump(): Promise<Blob> {
  dump ??= (async () => {
    const client = new PGlite();
    await runMigrations(drizzle(client) as unknown as HorosDb);
    const blob = await client.dumpDataDir("none");
    await client.close();
    return blob;
  })();
  return dump;
}

/** A fresh PGlite client whose database is already migrated. */
export async function migratedClient(): Promise<PGlite> {
  return new PGlite({ loadDataDir: await migratedDump() });
}
