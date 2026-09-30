import { emptyDb, type TestClient } from "@horos/adapters/testing";
import { afterEach, describe, expect, test } from "vitest";
import { DRILL_CUSTOMER, DRILL_ENFORCED, DRILL_SHADOW, seedDrillScopes, tamperRecord } from "./seed.ts";
import { checkMigrations, formatResult, verifyAllScopes } from "./verify-all-scopes.ts";

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

async function seeded() {
  const { client, db } = await emptyDb();
  clients.push(client);
  await seedDrillScopes(db);
  return db;
}

describe("verifyAllScopes", () => {
  test("two valid Scope chains: each ok", async () => {
    const db = await seeded();
    const results = await verifyAllScopes(db);
    expect(results).toEqual([
      { scope: DRILL_ENFORCED, ok: true, count: 3, headHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
      { scope: DRILL_SHADOW, ok: true, count: 3, headHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
    ]);
    const first = results[0];
    if (first === undefined || !first.ok) throw new Error("expected ok");
    expect(formatResult(first)).toBe(`${DRILL_ENFORCED}  ok  (3 records, head ${first.headHash})`);
    expect(await checkMigrations(db)).toMatchObject({ ok: true });
  });

  test("a tampered record breaks only its own Scope, which is named", async () => {
    const db = await seeded();
    await tamperRecord(db, DRILL_ENFORCED, 1);
    const results = await verifyAllScopes(db);
    expect(results[0]).toMatchObject({ scope: DRILL_ENFORCED, ok: false, firstBreak: { line: 2, seq: 1 } });
    expect(results[1]).toMatchObject({ scope: DRILL_SHADOW, ok: true, count: 3 });
    const broken = results[0];
    if (broken === undefined) throw new Error("no results");
    expect(formatResult(broken)).toContain(`${DRILL_ENFORCED}  BROKEN  at line 2 (seq 1)`);
  });
});

describe("verifyAllScopes: malformed ids and migration drift", () => {
  test("a malformed Scope id is reported as that Scope's break; the others are still verified", async () => {
    const db = await seeded();
    const client = clients.at(-1);
    // The schema's CHECK forbids this; a damaged or hand-edited restore might not have it.
    await client?.query("ALTER TABLE scope DROP CONSTRAINT scope_id_matches_kind");
    await client?.query(`INSERT INTO scope (id, kind, customer_id) VALUES ('shadow:not-a-uuid', 'shadow', '${DRILL_CUSTOMER}')`);
    const results = await verifyAllScopes(db);
    expect(results.find((r) => r.scope === "shadow:not-a-uuid")).toEqual({ scope: "shadow:not-a-uuid", ok: false, firstBreak: { line: 0, reason: "malformed scope id" } });
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  test("a database behind this build's migrations is a mismatch", async () => {
    const db = await seeded();
    await clients.at(-1)?.query("DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)");
    const m = await checkMigrations(db);
    expect(m.ok).toBe(false);
    expect(m.applied).toBe(m.bundled - 1);
  });
});
