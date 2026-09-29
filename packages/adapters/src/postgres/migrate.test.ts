import { afterEach, describe, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "./migrate.js";
import { freshDb } from "./test-db.js";

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});
async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return r;
}

const ROW = `('01926f3a-7b2c-7d4e-8f00-0123456789ab', 'advisory-public', 1, NULL, 'standard@1', 'preset', '{}'::jsonb)`;
const COLS = `(id, scope, seq, parent_id, preset_version, activation, policy)`;

describe("migrations", () => {
  test("create policy_version and a NOLOGIN horos_app with exactly SELECT, INSERT", async () => {
    const { client } = await setup();
    const table = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'policy_version'`,
    );
    expect(table.rows[0]?.n).toBe(1);
    const role = await client.query<{ rolcanlogin: boolean }>(`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'horos_app'`);
    expect(role.rows).toEqual([{ rolcanlogin: false }]);
    const grants = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'horos_app' AND table_name = 'policy_version' ORDER BY privilege_type`,
    );
    expect(grants.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  test("are idempotent (re-running applies nothing and does not fail)", async () => {
    const { db, client } = await setup();
    await runMigrations(db);
    const n = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(n.rows[0]?.n).toBe(7);
  });

  test("the migration's role creation tolerates a pre-existing horos_app", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = new PGlite();
    clients.push(client);
    await client.exec(`CREATE ROLE horos_app NOLOGIN`);
    await runMigrations(drizzle(client));
    const role = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'horos_app'`);
    expect(role.rows).toHaveLength(1);
  });

  test("seq must be >= 1, activation must be known, (scope, seq) is unique", async () => {
    const { client } = await setup();
    await expect(client.exec(`INSERT INTO policy_version ${COLS} VALUES ${ROW.replace(", 1,", ", 0,")}`)).rejects.toThrow();
    await expect(client.exec(`INSERT INTO policy_version ${COLS} VALUES ${ROW.replace("'preset'", "'human'")}`)).rejects.toThrow();
    await client.exec(`INSERT INTO policy_version ${COLS} VALUES ${ROW}`);
    await expect(
      client.exec(`INSERT INTO policy_version ${COLS} VALUES ${ROW.replace("0123456789ab'", "0123456789ac'")}`),
    ).rejects.toThrow(/unique/i);
  });
});

describe("horos_app role", () => {
  test("can INSERT and SELECT but not UPDATE, DELETE or TRUNCATE", async () => {
    const { client } = await setup();
    await client.exec(`SET ROLE horos_app`);
    await client.exec(`INSERT INTO policy_version ${COLS} VALUES ${ROW}`);
    const rows = await client.query(`SELECT id FROM policy_version`);
    expect(rows.rows).toHaveLength(1);
    await expect(client.exec(`UPDATE policy_version SET seq = 2`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM policy_version`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`TRUNCATE policy_version`)).rejects.toThrow(/permission denied/);
    await client.exec(`RESET ROLE`);
    const after = await client.query(`SELECT seq FROM policy_version`);
    expect(after.rows).toEqual([{ seq: 1 }]);
  });
});

describe("migration 0001 (lists and jobs)", () => {
  const grantsOf = async (client: PGlite, table: string) =>
    (
      await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'horos_app' AND table_name = $1 ORDER BY privilege_type`,
        [table],
      )
    ).rows.map((r) => r.privilege_type);

  test("horos_app holds exactly SELECT, INSERT on list_snapshot and SELECT, INSERT, UPDATE on list_source and job", async () => {
    const { client } = await setup();
    expect(await grantsOf(client, "list_snapshot")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "list_source")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(await grantsOf(client, "job")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const n = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(n.rows[0]?.n).toBe(7);
  });

  test("as horos_app, list_snapshot cannot be updated or deleted; job and list_source can be updated", async () => {
    const { client } = await setup();
    await client.exec(`SET ROLE horos_app`);
    await client.exec(`INSERT INTO list_source (source) VALUES ('ofac-sdn')`);
    await client.exec(
      `INSERT INTO list_snapshot (id, source, content_hash, entries, address_count, status, fetched_at)
       VALUES ('01926f3a-7b2c-7d4e-8f00-0123456789ab', 'ofac-sdn', '0x${"0".repeat(64)}', '[]'::jsonb, 0, 'active', now())`,
    );
    await client.exec(`UPDATE list_source SET active_snapshot_id = '01926f3a-7b2c-7d4e-8f00-0123456789ab'`);
    await expect(client.exec(`UPDATE list_snapshot SET status = 'quarantined'`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM list_snapshot`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM list_source`)).rejects.toThrow(/permission denied/);
    await client.exec(`INSERT INTO job (kind, "window", updated_at) VALUES ('ofac-poll', '2026-09-26T10', now())`);
    await client.exec(`UPDATE job SET status = 'running'`);
    await expect(client.exec(`DELETE FROM job`)).rejects.toThrow(/permission denied/);
    await client.exec(`RESET ROLE`);
  });

  test("unknown sources and malformed content hashes are rejected", async () => {
    const { client } = await setup();
    await expect(client.exec(`INSERT INTO list_source (source) VALUES ('other-list')`)).rejects.toThrow(/list_source_source_valid/);
    await client.exec(`INSERT INTO list_source (source) VALUES ('ofac-sdn')`);
    const snap = (hash: string) =>
      `INSERT INTO list_snapshot (id, source, content_hash, entries, address_count, status, fetched_at)
       VALUES ('01926f3a-7b2c-7d4e-8f00-0123456789ab', 'ofac-sdn', '${hash}', '[]'::jsonb, 0, 'active', now())`;
    await expect(client.exec(snap("0x00"))).rejects.toThrow(/list_snapshot_content_hash_valid/);
    await expect(client.exec(snap(`0x${"A".repeat(64)}`))).rejects.toThrow(/list_snapshot_content_hash_valid/);
    await client.exec(snap(`0x${"a".repeat(64)}`));
  });

  test("status checks reject unknown values", async () => {
    const { client } = await setup();
    await expect(client.exec(`INSERT INTO job (kind, "window", status, updated_at) VALUES ('k', 'w', 'weird', now())`)).rejects.toThrow();
    await client.exec(`INSERT INTO list_source (source) VALUES ('ofac-sdn')`);
    await expect(
      client.exec(
        `INSERT INTO list_snapshot (id, source, content_hash, entries, address_count, status, fetched_at)
         VALUES ('01926f3a-7b2c-7d4e-8f00-0123456789ab', 'ofac-sdn', '0x${"0".repeat(64)}', '[]'::jsonb, 0, 'pending', now())`,
      ),
    ).rejects.toThrow();
  });
});

describe("migration 0002 (scopes and records)", () => {
  const grantsOf = async (client: PGlite, table: string) =>
    (
      await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'horos_app' AND table_name = $1 ORDER BY privilege_type`,
        [table],
      )
    ).rows.map((r) => r.privilege_type);

  const SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
  const H = (c: string) => `0x${c.repeat(64)}`;
  const RID = "01926f3a-8000-7000-8000-000000000001";

  test("horos_app holds exactly SELECT, INSERT on scope, decision_record, used_nonce and SELECT, INSERT, UPDATE on record_chain_head", async () => {
    const { client } = await setup();
    expect(await grantsOf(client, "scope")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "decision_record")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "used_nonce")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "record_chain_head")).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  test("as horos_app, decision_record and used_nonce cannot be updated or deleted", async () => {
    const { client } = await setup();
    await client.exec(`SET ROLE horos_app`);
    await client.exec(`INSERT INTO scope (id, kind, policy_wallet) VALUES ('${SCOPE}', 'enforced', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')`);
    await client.exec(`INSERT INTO record_chain_head (scope, next_seq, head_hash) VALUES ('${SCOPE}', 0, '${H("0")}')`);
    await client.exec(
      `INSERT INTO decision_record (id, scope, seq, prev_hash, record_hash, record, created_at)
       VALUES ('${RID}', '${SCOPE}', 0, '${H("0")}', '${H("a")}', '{}'::jsonb, now())`,
    );
    await client.exec(`INSERT INTO used_nonce (scope, nonce, record_id) VALUES ('${SCOPE}', '${H("b")}', '${RID}')`);
    await client.exec(`UPDATE record_chain_head SET next_seq = 1, head_hash = '${H("a")}'`);
    await expect(client.exec(`UPDATE decision_record SET seq = 5`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM decision_record`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`UPDATE used_nonce SET nonce = '${H("c")}'`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM used_nonce`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM scope`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`UPDATE scope SET kind = 'shadow'`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM record_chain_head`)).rejects.toThrow(/permission denied/);
    await client.exec(`RESET ROLE`);
  });

  test("checks reject bad scopes, hex and seq; (scope, seq) and (scope, prev_hash) are unique", async () => {
    const { client } = await setup();
    await expect(client.exec(`INSERT INTO scope (id, kind, policy_wallet) VALUES ('enforced:abc', 'enforced', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')`)).rejects.toThrow(/scope_id_matches_kind/);
    await expect(client.exec(`INSERT INTO scope (id, kind, customer_id) VALUES ('${SCOPE}', 'shadow', '01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f')`)).rejects.toThrow(/scope_id_matches_kind/);
    await expect(client.exec(`INSERT INTO scope (id, kind) VALUES ('advisory-public', 'weird')`)).rejects.toThrow();
    await expect(
      client.exec(`INSERT INTO scope (id, kind) VALUES ('advisory-public:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80', 'advisory-public')`),
    ).rejects.toThrow(/scope_id_matches_kind/);
    await expect(client.exec(`INSERT INTO scope (id, kind) VALUES ('${SCOPE}', 'enforced')`)).rejects.toThrow(/scope_enforced_has_policy_wallet/);
    await expect(
      client.exec(`INSERT INTO scope (id, kind) VALUES ('shadow:01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f', 'shadow')`),
    ).rejects.toThrow(/scope_shadow_has_customer/);
    await client.exec(
      `INSERT INTO scope (id, kind, customer_id) VALUES ('shadow:01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f', 'shadow', '01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f')`,
    );
    await client.exec(`INSERT INTO scope (id, kind) VALUES ('advisory-public', 'advisory-public')`);
    await client.exec(`INSERT INTO scope (id, kind, policy_wallet) VALUES ('${SCOPE}', 'enforced', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')`);
    const rec = (id: string, seq: number, prev: string, hash: string) =>
      `INSERT INTO decision_record (id, scope, seq, prev_hash, record_hash, record, created_at)
       VALUES ('${id}', '${SCOPE}', ${seq}, '${prev}', '${hash}', '{}'::jsonb, now())`;
    await expect(client.exec(rec(RID, -1, H("0"), H("a")))).rejects.toThrow(/decision_record_seq_nonnegative/);
    await expect(client.exec(rec(RID, 0, "0x00", H("a")))).rejects.toThrow(/decision_record_prev_hash_valid/);
    await expect(client.exec(rec(RID, 0, H("0"), H("A")))).rejects.toThrow(/decision_record_record_hash_valid/);
    await client.exec(rec(RID, 0, H("0"), H("a")));
    await expect(client.exec(rec("01926f3a-8000-7000-8000-000000000002", 0, H("1"), H("b")))).rejects.toThrow(/decision_record_scope_seq_unique/);
    await expect(client.exec(rec("01926f3a-8000-7000-8000-000000000002", 1, H("0"), H("b")))).rejects.toThrow(/decision_record_scope_prev_hash_unique/);
  });
});

describe("migration 0003 (accounts and outbox)", () => {
  const grantsOf = async (client: PGlite, table: string) =>
    (
      await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'horos_app' AND table_name = $1 ORDER BY privilege_type`,
        [table],
      )
    ).rows.map((r) => r.privilege_type);

  test("horos_app holds exactly the listed grants on the new tables", async () => {
    const { client } = await setup();
    expect(await grantsOf(client, "customer")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "customer_webhook")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "enforced_binding")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(await grantsOf(client, "outbox_intent")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(await grantsOf(client, "account_nonce")).toEqual(["INSERT", "SELECT"]);
  });

  test("as horos_app, customers, webhooks and nonces cannot be updated or deleted", async () => {
    const { client } = await setup();
    const C = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
    await client.exec(`SET ROLE horos_app`);
    await client.exec(`INSERT INTO customer (id, payment_address) VALUES ('${C}', '0x705f7d75b1689c42034ca5102700be481edca2da')`);
    await client.exec(`INSERT INTO customer_webhook (id, customer_id, url, created_at) VALUES ('${C}', '${C}', '', now())`);
    await client.exec(
      `INSERT INTO enforced_binding (customer_id, scope_id, updated_at) VALUES ('${C}', 'enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80', now())`,
    );
    await client.exec(`UPDATE enforced_binding SET registrar = '0x7434fc9d31febe08082a710b255f3fe51b6a7ffc'`);
    await client.exec(`INSERT INTO account_nonce (payment_address, nonce, created_at) VALUES ('0x705f7d75b1689c42034ca5102700be481edca2da', '0x${"0".repeat(64)}', now())`);
    await expect(client.exec(`UPDATE customer SET category = 'real-business'`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM customer_webhook`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`UPDATE customer_webhook SET url = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM account_nonce`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM enforced_binding`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM outbox_intent`)).rejects.toThrow(/permission denied/);
    await client.exec(`RESET ROLE`);
  });

  test("checks reject bad categories, scope ids and a bound binding without a wallet", async () => {
    const { client } = await setup();
    const C = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
    await expect(client.exec(`INSERT INTO customer (id, payment_address, category) VALUES ('${C}', '0x705f7d75b1689c42034ca5102700be481edca2da', 'vip')`)).rejects.toThrow(/customer_category_valid/);
    await expect(client.exec(`INSERT INTO customer (id, payment_address) VALUES ('${C}', '0x705F7D75B1689C42034CA5102700BE481EDCA2DA')`)).rejects.toThrow(/customer_payment_address_valid/);
    await client.exec(`INSERT INTO customer (id, payment_address) VALUES ('${C}', '0x705f7d75b1689c42034ca5102700be481edca2da')`);
    await expect(client.exec(`INSERT INTO enforced_binding (customer_id, scope_id, updated_at) VALUES ('${C}', 'shadow:x', now())`)).rejects.toThrow(/enforced_binding_scope_id_valid/);
    await expect(
      client.exec(`INSERT INTO enforced_binding (customer_id, scope_id, status, updated_at) VALUES ('${C}', 'enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80', 'bound', now())`),
    ).rejects.toThrow(/enforced_binding_bound_has_wallet/);
  });
});

describe("migration 0004 (indexer, receipts, mirror)", () => {
  const grantsOf = async (client: PGlite, table: string) =>
    (
      await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'horos_app' AND table_name = $1 ORDER BY privilege_type`,
        [table],
      )
    ).rows.map((r) => r.privilege_type);
  const SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
  const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
  const CP = "0x1111111111111111111111111111111111111111";
  const H = (c: string) => `0x${c.repeat(64)}`;
  const RID = "01926f3a-8000-7000-8000-000000000001";
  const IID = "01926f3a-8000-7000-8000-0000000000aa";
  const intent = `INSERT INTO outbox_intent (id, scope, counterparty, lane_role, target, human_epoch, record_ids, created_by_record, send_record_hash, next_attempt_at, created_at, updated_at)
    VALUES ('${IID}', '${SCOPE}', '${CP}', 'registrar', 1, 0, ARRAY['${RID}'::uuid], '${RID}', '${H("a")}', now(), now(), now())`;

  test("horos_app holds exactly the listed grants on the new tables", async () => {
    const { client } = await setup();
    expect(await grantsOf(client, "counterparty_mirror")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(await grantsOf(client, "write_receipt")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "paid_event")).toEqual(["INSERT", "SELECT"]);
    expect(await grantsOf(client, "indexer_cursor")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const col = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'outbox_intent' AND column_name = 'merged_into'`,
    );
    expect(col.rows).toEqual([{ data_type: "uuid", is_nullable: "YES" }]);
  });

  test("as horos_app, receipts and paid events cannot be updated or deleted; the mirror and cursor can be updated", async () => {
    const { client } = await setup();
    await client.exec(`SET ROLE horos_app`);
    await client.exec(`INSERT INTO scope (id, kind, policy_wallet) VALUES ('${SCOPE}', 'enforced', '${WALLET}')`);
    await client.exec(
      `INSERT INTO decision_record (id, scope, seq, prev_hash, record_hash, record, created_at)
       VALUES ('${RID}', '${SCOPE}', 0, '${H("0")}', '${H("a")}', '{}'::jsonb, now())`,
    );
    await client.exec(intent);
    await client.exec(
      `INSERT INTO write_receipt (id, scope, record_id, outbox_intent_id, status, created_at) VALUES ('${RID}', '${SCOPE}', '${RID}', '${IID}', 'noop', now())`,
    );
    await client.exec(
      `INSERT INTO paid_event (policy_wallet, tx_hash, log_index, scope, counterparty, amount, record_hash, block_number, block_timestamp)
       VALUES ('${WALLET}', '${H("b")}', 0, '${SCOPE}', '${CP}', 5, '${H("c")}', 7, now())`,
    );
    await client.exec(
      `INSERT INTO counterparty_mirror (scope, address, last_block, last_log_index, updated_at) VALUES ('${SCOPE}', '${CP}', 1, 0, now())`,
    );
    await client.exec(`UPDATE counterparty_mirror SET "limit" = 5`);
    await client.exec(`INSERT INTO indexer_cursor (policy_wallet, scope, next_block, updated_at) VALUES ('${WALLET}', '${SCOPE}', 1, now())`);
    await client.exec(`UPDATE indexer_cursor SET next_block = 2`);
    await expect(client.exec(`UPDATE write_receipt SET status = 'failed_terminal'`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM write_receipt`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`UPDATE paid_event SET amount = 6`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM paid_event`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM counterparty_mirror`)).rejects.toThrow(/permission denied/);
    await expect(client.exec(`DELETE FROM indexer_cursor`)).rejects.toThrow(/permission denied/);
    await client.exec(`RESET ROLE`);
  });

  test("checks: receipt status, confirmed receipts need tx/limit/block, one (record, intent, status); one external record per (scope, txHash)", async () => {
    const { client } = await setup();
    await client.exec(`INSERT INTO scope (id, kind, policy_wallet) VALUES ('${SCOPE}', 'enforced', '${WALLET}')`);
    const rec = (id: string, seq: number, prev: string, hash: string, body: string) =>
      `INSERT INTO decision_record (id, scope, seq, prev_hash, record_hash, record, created_at)
       VALUES ('${id}', '${SCOPE}', ${seq}, '${prev}', '${hash}', '${body}'::jsonb, now())`;
    await client.exec(rec(RID, 0, H("0"), H("a"), "{}"));
    await client.exec(intent);
    const receipt = (id: string, status: string, extra = "NULL, NULL, NULL", intentId = `'${IID}'`) =>
      `INSERT INTO write_receipt (id, scope, record_id, outbox_intent_id, status, tx_hash, onchain_limit_after, block_number, created_at)
       VALUES ('${id}', '${SCOPE}', '${RID}', ${intentId}, '${status}', ${extra}, now())`;
    await expect(client.exec(receipt(RID, "failed_retrying"))).rejects.toThrow(/write_receipt_status_valid/);
    await expect(client.exec(receipt(RID, "confirmed"))).rejects.toThrow(/write_receipt_confirmed_has_tx/);
    await expect(client.exec(receipt(RID, "noop", "NULL, NULL, NULL", "NULL"))).rejects.toThrow(/null value|not-null/);
    await client.exec(receipt(RID, "confirmed", `'${H("b")}', 100, 7`));
    await expect(client.exec(receipt("01926f3a-8000-7000-8000-0000000000bb", "confirmed", `'${H("b")}', 100, 7`))).rejects.toThrow(
      /write_receipt_record_intent_status_unique/,
    );
    const ext = (txHash: string) => `{"recordType":"external","txHash":"${txHash}"}`;
    await client.exec(rec("01926f3a-8000-7000-8000-000000000002", 1, H("a"), H("c"), ext(H("d"))));
    await expect(client.exec(rec("01926f3a-8000-7000-8000-000000000003", 2, H("c"), H("e"), ext(H("d"))))).rejects.toThrow(
      /decision_record_external_tx_unique/,
    );
    await client.exec(rec("01926f3a-8000-7000-8000-000000000003", 2, H("c"), H("e"), ext(H("f"))));
    await expect(
      client.exec(`INSERT INTO counterparty_mirror (scope, address, pinned, "limit", last_block, last_log_index, updated_at) VALUES ('${SCOPE}', '${CP}', true, 5, 1, 0, now())`),
    ).rejects.toThrow(/counterparty_mirror_pinned_limit_zero/);
  });
});
