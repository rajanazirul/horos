CREATE TABLE "counterparty_mirror" (
	"scope" text NOT NULL,
	"address" text NOT NULL,
	"registered" boolean DEFAULT false NOT NULL,
	"limit" numeric(38, 0) DEFAULT '0' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"human_set" boolean DEFAULT false NOT NULL,
	"human_epoch" numeric DEFAULT '0' NOT NULL,
	"unpin_requested_at" numeric,
	"first_registered_block" bigint,
	"last_block" bigint NOT NULL,
	"last_log_index" integer NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "counterparty_mirror_pkey" PRIMARY KEY("scope","address"),
	CONSTRAINT "counterparty_mirror_address_valid" CHECK ("counterparty_mirror"."address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "counterparty_mirror_limit_nonnegative" CHECK ("counterparty_mirror"."limit" >= 0),
	CONSTRAINT "counterparty_mirror_pinned_limit_zero" CHECK (NOT "counterparty_mirror"."pinned" OR "counterparty_mirror"."limit" = 0)
);
--> statement-breakpoint
CREATE TABLE "indexer_cursor" (
	"policy_wallet" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"next_block" bigint NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "indexer_cursor_policy_wallet_valid" CHECK ("indexer_cursor"."policy_wallet" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "indexer_cursor_next_block_nonnegative" CHECK ("indexer_cursor"."next_block" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paid_event" (
	"policy_wallet" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"scope" text NOT NULL,
	"counterparty" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"record_hash" text NOT NULL,
	"matched_record_id" uuid,
	"block_number" bigint NOT NULL,
	"block_timestamp" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "paid_event_pkey" PRIMARY KEY("tx_hash","log_index"),
	CONSTRAINT "paid_event_counterparty_valid" CHECK ("paid_event"."counterparty" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "paid_event_record_hash_valid" CHECK ("paid_event"."record_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "paid_event_amount_nonnegative" CHECK ("paid_event"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "write_receipt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"record_id" uuid NOT NULL,
	"outbox_intent_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tx_hash" text,
	"onchain_limit_after" numeric(38, 0),
	"block_number" bigint,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "write_receipt_record_intent_status_unique" UNIQUE("record_id","outbox_intent_id","status"),
	CONSTRAINT "write_receipt_status_valid" CHECK ("write_receipt"."status" IN ('confirmed', 'noop', 'superseded_by_human', 'failed_terminal')),
	CONSTRAINT "write_receipt_tx_hash_valid" CHECK ("write_receipt"."tx_hash" IS NULL OR "write_receipt"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "write_receipt_confirmed_has_tx" CHECK ("write_receipt"."status" <> 'confirmed' OR ("write_receipt"."tx_hash" IS NOT NULL AND "write_receipt"."onchain_limit_after" IS NOT NULL AND "write_receipt"."block_number" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "outbox_intent" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "counterparty_mirror" ADD CONSTRAINT "counterparty_mirror_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer_cursor" ADD CONSTRAINT "indexer_cursor_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_event" ADD CONSTRAINT "paid_event_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_event" ADD CONSTRAINT "paid_event_matched_record_id_decision_record_id_fk" FOREIGN KEY ("matched_record_id") REFERENCES "public"."decision_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_receipt" ADD CONSTRAINT "write_receipt_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_receipt" ADD CONSTRAINT "write_receipt_record_id_decision_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."decision_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_receipt" ADD CONSTRAINT "write_receipt_outbox_intent_id_outbox_intent_id_fk" FOREIGN KEY ("outbox_intent_id") REFERENCES "public"."outbox_intent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paid_event_scope_counterparty_idx" ON "paid_event" USING btree ("scope","counterparty");--> statement-breakpoint
CREATE INDEX "write_receipt_intent_idx" ON "write_receipt" USING btree ("outbox_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_record_external_tx_unique" ON "decision_record" USING btree ("scope",("record"->>'txHash')) WHERE "decision_record"."record"->>'recordType' = 'external';--> statement-breakpoint
-- App role grants (AD-9, AD-14, AD-24). horos_app already exists (0000). WriteReceipts and Paid history are
-- insert-only for the app; the Counterparty mirror and the indexer cursor are mutable. Never DELETE or TRUNCATE.
REVOKE ALL ON TABLE "counterparty_mirror" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "counterparty_mirror" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "write_receipt" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "write_receipt" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "paid_event" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "paid_event" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "indexer_cursor" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "indexer_cursor" TO horos_app;
