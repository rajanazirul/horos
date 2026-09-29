#!/usr/bin/env node
// `verify-all-scopes` (Story 2.10, AD-9): export every Scope's record chain with `exportScopeChain` and check it
// with the published verifier (`verifyChain`). Prints one line per Scope (record count and head hash) and a JSON
// summary; exits 1 when any chain breaks (naming the Scope and the first broken line), when a Scope id is malformed,
// or when the database's applied migration count differs from this build's journal; 2 on usage or connection errors.
//
//   DATABASE_URL=postgres://... node tools/ops/verify-all-scopes.ts
//
// Runs directly with Node >= 24 (type stripping) against the built workspace (`pnpm turbo run build`). The
// restore drill points it at a throwaway restored copy; it only reads.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appliedMigrationCount,
  bundledMigrationCount,
  connectPostgres,
  exportScopeChain,
  redactString,
  scope as scopeTable,
  type HorosDb,
} from "@horos/adapters";
import { Scope } from "@horos/schema";
import { verifyChain, type ChainBreak } from "@horos/verify";

export type ScopeResult =
  | { readonly scope: string; readonly ok: true; readonly count: number; readonly headHash?: string }
  | { readonly scope: string; readonly ok: false; readonly firstBreak: ChainBreak };

/** The stored hash on the export's last line (the chain head), when readable. */
function headHashOf(text: string): string | undefined {
  const last = text.trimEnd().split("\n").at(-1);
  if (last === undefined || last === "") return undefined;
  try {
    const h = (JSON.parse(last) as { recordHash?: unknown }).recordHash;
    return typeof h === "string" ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify every Scope's chain, in Scope-id order. A Scope with no records verifies with count 0. A malformed Scope id
 * is reported as a break for that Scope (line 0) and the others are still verified.
 */
export async function verifyAllScopes(db: HorosDb): Promise<ScopeResult[]> {
  const rows = await db.select({ id: scopeTable.id }).from(scopeTable).orderBy(scopeTable.id);
  const results: ScopeResult[] = [];
  for (const { id } of rows) {
    const parsed = Scope.safeParse(id);
    if (!parsed.success) {
      results.push({ scope: id, ok: false, firstBreak: { line: 0, reason: "malformed scope id" } });
      continue;
    }
    const text = await exportScopeChain(db, parsed.data);
    const r = text === "" ? ({ ok: true, count: 0 } as const) : verifyChain(text);
    const head = headHashOf(text);
    results.push(r.ok ? { scope: id, ok: true, count: r.count, ...(head === undefined ? {} : { headHash: head }) } : { scope: id, ok: false, firstBreak: r.firstBreak });
  }
  return results;
}

export function formatResult(r: ScopeResult): string {
  return r.ok
    ? `${r.scope}  ok  (${r.count} record${r.count === 1 ? "" : "s"}, head ${r.headHash ?? "none"})`
    : `${r.scope}  BROKEN  at line ${r.firstBreak.line}${r.firstBreak.seq === undefined ? "" : ` (seq ${r.firstBreak.seq})`}: ${r.firstBreak.reason}`;
}

/** The restored database's applied migrations against this build's journal. */
export async function checkMigrations(db: HorosDb): Promise<{ readonly ok: boolean; readonly applied: number; readonly bundled: number }> {
  const applied = await appliedMigrationCount(db);
  const bundled = bundledMigrationCount();
  return { ok: applied === bundled, applied, bundled };
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env, out = console.log, err = console.error): Promise<number> {
  const url = env["DATABASE_URL"];
  if (url === undefined || url === "") {
    err("verify-all-scopes: DATABASE_URL is required");
    return 2;
  }
  const conn = connectPostgres(url, 1);
  try {
    const migrations = await checkMigrations(conn.db);
    out(`migrations  ${migrations.ok ? "ok" : "MISMATCH"}  (applied ${migrations.applied}, this build bundles ${migrations.bundled})`);
    const results = await verifyAllScopes(conn.db);
    for (const r of results) out(formatResult(r));
    const broken = results.filter((r) => !r.ok).map((r) => r.scope);
    out(JSON.stringify({ migrations, scopes: results.length, ok: results.length - broken.length, broken }));
    return broken.length === 0 && migrations.ok ? 0 : 1;
  } catch (e) {
    err(`verify-all-scopes: ${redactString(e instanceof Error ? e.message : String(e))}`);
    return 2;
  } finally {
    await conn.close();
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
