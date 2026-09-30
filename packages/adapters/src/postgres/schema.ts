// Postgres schema (drizzle). Schema changes ship only as committed SQL migrations in ../../drizzle
// (generated with `drizzle-kit generate`; never `push`). AD-14, AD-25.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** Insert-only PolicyVersions. The active version of a scope is the row with the highest `seq`. */
export const policyVersion = pgTable(
  "policy_version",
  {
    id: uuid("id").primaryKey(),
    scope: text("scope").notNull(),
    seq: integer("seq").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => policyVersion.id),
    presetVersion: text("preset_version").notNull(),
    activation: text("activation").notNull(),
    policy: jsonb("policy").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("policy_version_scope_seq_unique").on(t.scope, t.seq),
    check("policy_version_seq_positive", sql`${t.seq} >= 1`),
    check("policy_version_activation_valid", sql`${t.activation} IN ('preset', 'tighter-proof')`),
  ],
);

const ts3 = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: "date" });

/**
 * One row per list source (`ofac-sdn`, `horos-demo-list`): a mutable pointer to the active snapshot plus
 * freshness (AD-10, AD-21). `last_verified_at` moves on every successful poll, including 304.
 */
export const listSource = pgTable(
  "list_source",
  {
    source: text("source").primaryKey(),
    lastVerifiedAt: ts3("last_verified_at"),
    lastModified: text("last_modified"),
    activeSnapshotId: uuid("active_snapshot_id").references((): AnyPgColumn => listSnapshot.id),
    /** Content hash of the last quarantined snapshot whose founder alert was delivered. */
    quarantineAlertedHash: text("quarantine_alerted_hash"),
  },
  (t) => [check("list_source_source_valid", sql`${t.source} IN ('ofac-sdn', 'horos-demo-list')`)],
);

/**
 * Insert-only, content-addressed list snapshots, unique per `(source, content_hash, status)`: promoting
 * previously quarantined content inserts a new `active` row. The active snapshot is whatever
 * `list_source.active_snapshot_id` points at, and it is always an `active` row.
 */
export const listSnapshot = pgTable(
  "list_snapshot",
  {
    id: uuid("id").primaryKey(),
    source: text("source")
      .notNull()
      .references((): AnyPgColumn => listSource.source),
    contentHash: text("content_hash").notNull(),
    entries: jsonb("entries").notNull(),
    addressCount: integer("address_count").notNull(),
    status: text("status").notNull(),
    fetchedAt: ts3("fetched_at").notNull(),
  },
  (t) => [
    unique("list_snapshot_source_content_hash_status_unique").on(t.source, t.contentHash, t.status),
    check("list_snapshot_source_valid", sql`${t.source} IN ('ofac-sdn', 'horos-demo-list')`),
    check("list_snapshot_content_hash_valid", sql`${t.contentHash} ~ '^0x[0-9a-f]{64}$'`),
    check("list_snapshot_status_valid", sql`${t.status} IN ('active', 'quarantined')`),
    check("list_snapshot_address_count_nonnegative", sql`${t.addressCount} >= 0`),
  ],
);

/** Idempotent worker jobs keyed `(kind, window)`, claimed with `FOR UPDATE SKIP LOCKED` (AD-20). */
export const job = pgTable(
  "job",
  {
    kind: text("kind").notNull(),
    window: text("window").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: ts3("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "job_pkey", columns: [t.kind, t.window] }),
    check("job_status_valid", sql`${t.status} IN ('pending', 'running', 'done', 'failed')`),
    check("job_attempts_nonnegative", sql`${t.attempts} >= 0`),
  ],
);

/** Every Scope (AD-25): `enforced:<policyWalletId>`, `shadow:<customerId>` or `advisory-public`. Insert-only. */
export const scope = pgTable(
  "scope",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    customerId: uuid("customer_id"),
    policyWallet: text("policy_wallet"),
    createdAt: ts3("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("scope_kind_valid", sql`${t.kind} IN ('enforced', 'shadow', 'advisory-public')`),
    check(
      "scope_id_matches_kind",
      sql`CASE ${t.kind} WHEN 'advisory-public' THEN ${t.id} = 'advisory-public' ELSE ${t.id} ~ ('^' || ${t.kind} || ':[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') END`,
    ),
    check("scope_enforced_has_policy_wallet", sql`${t.kind} <> 'enforced' OR ${t.policyWallet} IS NOT NULL`),
    check("scope_shadow_has_customer", sql`${t.kind} <> 'shadow' OR ${t.customerId} IS NOT NULL`),
    check("scope_policy_wallet_valid", sql`${t.policyWallet} IS NULL OR ${t.policyWallet} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

/** The per-Scope chain head, locked `FOR UPDATE` only around build + insert (AD-9). Mutable. */
export const recordChainHead = pgTable(
  "record_chain_head",
  {
    scope: text("scope")
      .primaryKey()
      .references((): AnyPgColumn => scope.id),
    nextSeq: integer("next_seq").notNull(),
    headHash: text("head_hash").notNull(),
  },
  (t) => [
    check("record_chain_head_next_seq_nonnegative", sql`${t.nextSeq} >= 0`),
    check("record_chain_head_head_hash_valid", sql`${t.headHash} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

/**
 * Append-only, hash-chained Scope records (AD-9, FR-26): DecisionRecords and, from Story 2.7, ExternalRecords.
 * `record` is the parsed ScopeRecord.
 */
export const decisionRecord = pgTable(
  "decision_record",
  {
    id: uuid("id").primaryKey(),
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    seq: integer("seq").notNull(),
    prevHash: text("prev_hash").notNull(),
    recordHash: text("record_hash").notNull(),
    record: jsonb("record").notNull(),
    createdAt: ts3("created_at").notNull(),
  },
  (t) => [
    unique("decision_record_record_hash_unique").on(t.recordHash),
    unique("decision_record_scope_seq_unique").on(t.scope, t.seq),
    unique("decision_record_scope_prev_hash_unique").on(t.scope, t.prevHash),
    // One ExternalRecord per (Scope, observed transaction): the Story 2.7 indexer's idempotency guard.
    // Story 2.8 status reads: one Counterparty's records in a Scope, in seq order.
    index("decision_record_scope_counterparty_seq_idx").on(t.scope, sql`(${t.record}->>'counterparty')`, t.seq),
    uniqueIndex("decision_record_external_tx_unique")
      .on(t.scope, sql`(${t.record}->>'txHash')`)
      .where(sql`${t.record}->>'recordType' = 'external'`),
    check("decision_record_seq_nonnegative", sql`${t.seq} >= 0`),
    check("decision_record_prev_hash_valid", sql`${t.prevHash} ~ '^0x[0-9a-f]{64}$'`),
    check("decision_record_record_hash_valid", sql`${t.recordHash} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

/** Check nonces consumed atomically with their record, per Scope. Insert-only. */
export const usedNonce = pgTable(
  "used_nonce",
  {
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    nonce: text("nonce").notNull(),
    recordId: uuid("record_id")
      .notNull()
      .references((): AnyPgColumn => decisionRecord.id),
  },
  (t) => [
    primaryKey({ name: "used_nonce_pkey", columns: [t.scope, t.nonce] }),
    check("used_nonce_nonce_valid", sql`${t.nonce} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

/** Customers (AD-11, AD-15). One per Payment address; `category` feeds the traction ledger. Insert-only. */
export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey(),
    paymentAddress: text("payment_address").notNull(),
    category: text("category").notNull().default("own-test"),
    createdAt: ts3("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("customer_payment_address_unique").on(t.paymentAddress),
    check("customer_payment_address_valid", sql`${t.paymentAddress} ~ '^0x[0-9a-f]{40}$'`),
    check("customer_category_valid", sql`${t.category} IN ('own-test', 'other-team-test', 'real-business')`),
  ],
);

/** Customer webhook URLs. Insert-only; the latest row wins; `url` is `''` when none is set. */
export const customerWebhook = pgTable(
  "customer_webhook",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customer.id),
    url: text("url").notNull(),
    createdAt: ts3("created_at").notNull(),
  },
  (t) => [
    index("customer_webhook_customer_created_idx").on(t.customerId, t.createdAt),
    check("customer_webhook_url_length", sql`char_length(${t.url}) <= 2048`),
  ],
);

/**
 * A Customer's enforced binding (AD-15, AD-25): the reserved `enforced:<uuidv7>` Scope id, the provisioned
 * Registrar/Model/Rules EOAs and, once bound, the PolicyWallet. The `scope` row is created only at bind.
 */
export const enforcedBinding = pgTable(
  "enforced_binding",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references((): AnyPgColumn => customer.id),
    scopeId: text("scope_id").notNull(),
    status: text("status").notNull().default("pending"),
    policyWallet: text("policy_wallet"),
    registrar: text("registrar"),
    model: text("model"),
    rules: text("rules"),
    circleWalletSetId: text("circle_wallet_set_id"),
    circleRegistrarWalletId: text("circle_registrar_wallet_id"),
    circleModelWalletId: text("circle_model_wallet_id"),
    circleRulesWalletId: text("circle_rules_wallet_id"),
    updatedAt: ts3("updated_at").notNull(),
  },
  (t) => [
    unique("enforced_binding_scope_id_unique").on(t.scopeId),
    unique("enforced_binding_policy_wallet_unique").on(t.policyWallet),
    check("enforced_binding_status_valid", sql`${t.status} IN ('pending', 'bound')`),
    check(
      "enforced_binding_scope_id_valid",
      sql`${t.scopeId} ~ '^enforced:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check("enforced_binding_bound_has_wallet", sql`${t.status} <> 'bound' OR ${t.policyWallet} IS NOT NULL`),
    check(
      "enforced_binding_addresses_valid",
      sql`(${t.policyWallet} IS NULL OR ${t.policyWallet} ~ '^0x[0-9a-f]{40}$') AND (${t.registrar} IS NULL OR ${t.registrar} ~ '^0x[0-9a-f]{40}$') AND (${t.model} IS NULL OR ${t.model} ~ '^0x[0-9a-f]{40}$') AND (${t.rules} IS NULL OR ${t.rules} ~ '^0x[0-9a-f]{40}$')`,
    ),
  ],
);

/**
 * Coalescing outbox (AD-8): at most one `pending` intent per `(scope, counterparty)`; later decisions merge
 * into it until the worker claims it. Mutable; only the Story 2.7 indexer sets `confirmed`.
 */
export const outboxIntent = pgTable(
  "outbox_intent",
  {
    id: uuid("id").primaryKey(),
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    counterparty: text("counterparty").notNull(),
    laneRole: text("lane_role").notNull(),
    target: numeric("target", { precision: 38, scale: 0 }).notNull(),
    pin: boolean("pin").notNull().default(false),
    humanEpoch: numeric("human_epoch").notNull(),
    recordIds: uuid("record_ids").array().notNull(),
    createdByRecord: uuid("created_by_record").notNull(),
    sendRecordHash: text("send_record_hash").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts3("next_attempt_at").notNull(),
    alerted: boolean("alerted").notNull().default(false),
    circleTxId: text("circle_tx_id"),
    txHash: text("tx_hash"),
    lastError: text("last_error"),
    /** Set when a requeue merged this row into a newer pending intent (the row then ends as `noop`). */
    mergedInto: uuid("merged_into"),
    createdAt: ts3("created_at").notNull(),
    updatedAt: ts3("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("outbox_intent_pending_unique").on(t.scope, t.counterparty).where(sql`status = 'pending'`),
    index("outbox_intent_lane_idx").on(t.scope, t.laneRole, t.status),
    check("outbox_intent_status_valid", sql`${t.status} IN ('pending', 'sending', 'submitted', 'confirmed', 'noop', 'failed')`),
    check("outbox_intent_lane_role_valid", sql`${t.laneRole} IN ('registrar', 'rules')`),
    check("outbox_intent_counterparty_valid", sql`${t.counterparty} ~ '^0x[0-9a-f]{40}$'`),
    check("outbox_intent_send_record_hash_valid", sql`${t.sendRecordHash} ~ '^0x[0-9a-f]{64}$'`),
    check("outbox_intent_target_nonnegative", sql`${t.target} >= 0`),
    check("outbox_intent_pin_target_zero", sql`NOT ${t.pin} OR ${t.target} = 0`),
    check("outbox_intent_attempts_nonnegative", sql`${t.attempts} >= 0`),
  ],
);

/** Nonces of signed account requests (WebhookUpdate), per Payment address. Insert-only. */
export const accountNonce = pgTable(
  "account_nonce",
  {
    paymentAddress: text("payment_address").notNull(),
    nonce: text("nonce").notNull(),
    createdAt: ts3("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "account_nonce_pkey", columns: [t.paymentAddress, t.nonce] }),
    check("account_nonce_nonce_valid", sql`${t.nonce} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

/**
 * The indexer's Counterparty mirror (AD-24): one row per `(scope, address)`, written only by the Story 2.7
 * worker indexer. Each event applies only when its `(last_block, last_log_index)` position is later.
 */
export const counterpartyMirror = pgTable(
  "counterparty_mirror",
  {
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    address: text("address").notNull(),
    registered: boolean("registered").notNull().default(false),
    limit: numeric("limit", { precision: 38, scale: 0 }).notNull().default("0"),
    pinned: boolean("pinned").notNull().default(false),
    humanSet: boolean("human_set").notNull().default(false),
    humanEpoch: numeric("human_epoch").notNull().default("0"),
    /** Unix seconds of the pending Human unpin request; null when none. */
    unpinRequestedAt: numeric("unpin_requested_at"),
    firstRegisteredBlock: bigint("first_registered_block", { mode: "bigint" }),
    lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
    lastLogIndex: integer("last_log_index").notNull(),
    updatedAt: ts3("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "counterparty_mirror_pkey", columns: [t.scope, t.address] }),
    check("counterparty_mirror_address_valid", sql`${t.address} ~ '^0x[0-9a-f]{40}$'`),
    check("counterparty_mirror_limit_nonnegative", sql`${t.limit} >= 0`),
    check("counterparty_mirror_pinned_limit_zero", sql`NOT ${t.pinned} OR ${t.limit} = 0`),
  ],
);

/**
 * WriteReceipts (AD-24): how each record's Limit write ended. Insert-only; the indexer is the only writer.
 * `confirmed` rows come from the chain join; `noop` / `superseded_by_human` / `failed_terminal` from the
 * outbox's final states.
 */
export const writeReceipt = pgTable(
  "write_receipt",
  {
    id: uuid("id").primaryKey(),
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    recordId: uuid("record_id")
      .notNull()
      .references((): AnyPgColumn => decisionRecord.id),
    outboxIntentId: uuid("outbox_intent_id")
      .notNull()
      .references((): AnyPgColumn => outboxIntent.id),
    status: text("status").notNull(),
    txHash: text("tx_hash"),
    onchainLimitAfter: numeric("onchain_limit_after", { precision: 38, scale: 0 }),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    createdAt: ts3("created_at").notNull(),
  },
  (t) => [
    unique("write_receipt_record_intent_status_unique").on(t.recordId, t.outboxIntentId, t.status),
    index("write_receipt_intent_idx").on(t.outboxIntentId),
    check("write_receipt_status_valid", sql`${t.status} IN ('confirmed', 'noop', 'superseded_by_human', 'failed_terminal')`),
    check("write_receipt_tx_hash_valid", sql`${t.txHash} IS NULL OR ${t.txHash} ~ '^0x[0-9a-f]{64}$'`),
    check("write_receipt_confirmed_has_tx", sql`${t.status} <> 'confirmed' OR (${t.txHash} IS NOT NULL AND ${t.onchainLimitAfter} IS NOT NULL AND ${t.blockNumber} IS NOT NULL)`),
  ],
);

/** `Paid` history (AD-24). Insert-only; a `Paid` never creates a chain record. */
export const paidEvent = pgTable(
  "paid_event",
  {
    policyWallet: text("policy_wallet").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    counterparty: text("counterparty").notNull(),
    amount: numeric("amount", { precision: 38, scale: 0 }).notNull(),
    recordHash: text("record_hash").notNull(),
    matchedRecordId: uuid("matched_record_id").references((): AnyPgColumn => decisionRecord.id),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockTimestamp: ts3("block_timestamp").notNull(),
  },
  (t) => [
    primaryKey({ name: "paid_event_pkey", columns: [t.txHash, t.logIndex] }),
    index("paid_event_scope_counterparty_idx").on(t.scope, t.counterparty),
    check("paid_event_counterparty_valid", sql`${t.counterparty} ~ '^0x[0-9a-f]{40}$'`),
    check("paid_event_record_hash_valid", sql`${t.recordHash} ~ '^0x[0-9a-f]{64}$'`),
    check("paid_event_amount_nonnegative", sql`${t.amount} >= 0`),
  ],
);

/** Per-PolicyWallet indexer cursor: the next block to index. Mutable. */
export const indexerCursor = pgTable(
  "indexer_cursor",
  {
    policyWallet: text("policy_wallet").primaryKey(),
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    nextBlock: bigint("next_block", { mode: "bigint" }).notNull(),
    updatedAt: ts3("updated_at").notNull(),
  },
  (t) => [
    check("indexer_cursor_policy_wallet_valid", sql`${t.policyWallet} ~ '^0x[0-9a-f]{40}$'`),
    check("indexer_cursor_next_block_nonnegative", sql`${t.nextBlock} >= 0`),
  ],
);

const SHADOW_SCOPE_RE = "^shadow:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/**
 * Shadow Mode API keys (Story 3.4, AD-25). Only the sha256 of a key is stored. A sign-up revokes the Customer's
 * active key and inserts a new one, so at most one key per Customer is active. Rows are never deleted.
 */
export const shadowApiKey = pgTable(
  "shadow_api_key",
  {
    keyHash: text("key_hash").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customer.id),
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    createdAt: ts3("created_at").notNull(),
    revokedAt: ts3("revoked_at"),
  },
  (t) => [
    uniqueIndex("shadow_api_key_active_unique").on(t.customerId).where(sql`revoked_at IS NULL`),
    check("shadow_api_key_key_hash_valid", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
    check("shadow_api_key_scope_valid", sql`${t.scope} ~ ${sql.raw(`'${SHADOW_SCOPE_RE}'`)}`),
    check("shadow_api_key_scope_matches_customer", sql`${t.scope} = 'shadow:' || ${t.customerId}::text`),
  ],
);

/**
 * The shadow virtual ledger's per-Counterparty state (AD-7, AD-25): the virtual Registration, Limit and pin a shadow
 * Scope's Decisions would have written on-chain. Shadow Scopes only; enforced code never reads it. Mutable.
 */
export const shadowLedgerCounterparty = pgTable(
  "shadow_ledger_counterparty",
  {
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    counterparty: text("counterparty").notNull(),
    limit: numeric("limit", { precision: 78, scale: 0 }).notNull().default("0"),
    registered: boolean("registered").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
  },
  (t) => [
    primaryKey({ name: "shadow_ledger_counterparty_pkey", columns: [t.scope, t.counterparty] }),
    check("shadow_ledger_counterparty_scope_valid", sql`${t.scope} ~ ${sql.raw(`'${SHADOW_SCOPE_RE}'`)}`),
    check("shadow_ledger_counterparty_address_valid", sql`${t.counterparty} ~ '^0x[0-9a-f]{40}$'`),
    check("shadow_ledger_counterparty_limit_nonnegative", sql`${t.limit} >= 0`),
    check("shadow_ledger_counterparty_pinned_limit_zero", sql`NOT ${t.pinned} OR ${t.limit} = 0`),
  ],
);

/**
 * The shadow virtual ledger's day-bucket rings (AD-7): one row per `(scope, ring, slot_index)`, the Postgres form of
 * the contract's `RollingWindow.Ring`. `ring` is `wallet`, `new-payee` or `cp:<address>`. Mutable.
 */
export const shadowLedgerSlot = pgTable(
  "shadow_ledger_slot",
  {
    scope: text("scope")
      .notNull()
      .references((): AnyPgColumn => scope.id),
    ring: text("ring").notNull(),
    slotIndex: integer("slot_index").notNull(),
    dayIndex: bigint("day_index", { mode: "number" }).notNull(),
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
  },
  (t) => [
    primaryKey({ name: "shadow_ledger_slot_pkey", columns: [t.scope, t.ring, t.slotIndex] }),
    check("shadow_ledger_slot_scope_valid", sql`${t.scope} ~ ${sql.raw(`'${SHADOW_SCOPE_RE}'`)}`),
    check("shadow_ledger_slot_ring_valid", sql`${t.ring} IN ('wallet', 'new-payee') OR ${t.ring} ~ '^cp:0x[0-9a-f]{40}$'`),
    check("shadow_ledger_slot_index_range", sql`${t.slotIndex} >= 0 AND ${t.slotIndex} <= 90`),
    check("shadow_ledger_slot_index_matches_day", sql`${t.slotIndex} = ${t.dayIndex} % 91`),
    check("shadow_ledger_slot_day_index_range", sql`${t.dayIndex} >= 0 AND ${t.dayIndex} <= 4294967295`),
    check("shadow_ledger_slot_amount_range", sql`${t.amount} >= 0 AND ${t.amount} <= 26959946667150639794667015087019630673637144422540572481103610249215`),
  ],
);
