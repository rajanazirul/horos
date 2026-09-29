#!/usr/bin/env node
// Seeds a THROWAWAY database for the restore drill (Story 2.10): migrations, two Scopes, valid chains.
// `--tamper` additionally corrupts one enforced-Scope record, for the drill's negative case.
//
//   DATABASE_URL=postgres://postgres:...@localhost:<port>/postgres node tools/ops/seed-drill-db.ts [--tamper]
//
// Never point this at the hosted database.
import { connectPostgres } from "@horos/adapters";
import { DRILL_ENFORCED, seedDrillScopes, tamperRecord } from "./seed.ts";

const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("seed-drill-db: DATABASE_URL is required (a throwaway database)");
  process.exit(2);
}
const conn = connectPostgres(url, 1);
try {
  const scopes = await seedDrillScopes(conn.db);
  if (process.argv.includes("--tamper")) await tamperRecord(conn.db, DRILL_ENFORCED);
  console.log(JSON.stringify({ seeded: scopes, tampered: process.argv.includes("--tamper") ? DRILL_ENFORCED : null }));
} finally {
  await conn.close();
}
