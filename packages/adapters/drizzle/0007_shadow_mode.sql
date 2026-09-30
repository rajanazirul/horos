CREATE TABLE "shadow_api_key" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "shadow_api_key_key_hash_valid" CHECK ("shadow_api_key"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "shadow_api_key_scope_valid" CHECK ("shadow_api_key"."scope" ~ '^shadow:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "shadow_api_key_scope_matches_customer" CHECK ("shadow_api_key"."scope" = 'shadow:' || "shadow_api_key"."customer_id"::text)
);
--> statement-breakpoint
CREATE TABLE "shadow_ledger_counterparty" (
	"scope" text NOT NULL,
	"counterparty" text NOT NULL,
	"limit" numeric(78, 0) DEFAULT '0' NOT NULL,
	"registered" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "shadow_ledger_counterparty_pkey" PRIMARY KEY("scope","counterparty"),
	CONSTRAINT "shadow_ledger_counterparty_scope_valid" CHECK ("shadow_ledger_counterparty"."scope" ~ '^shadow:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "shadow_ledger_counterparty_address_valid" CHECK ("shadow_ledger_counterparty"."counterparty" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "shadow_ledger_counterparty_limit_nonnegative" CHECK ("shadow_ledger_counterparty"."limit" >= 0),
	CONSTRAINT "shadow_ledger_counterparty_pinned_limit_zero" CHECK (NOT "shadow_ledger_counterparty"."pinned" OR "shadow_ledger_counterparty"."limit" = 0)
);
--> statement-breakpoint
CREATE TABLE "shadow_ledger_slot" (
	"scope" text NOT NULL,
	"ring" text NOT NULL,
	"slot_index" integer NOT NULL,
	"day_index" bigint NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	CONSTRAINT "shadow_ledger_slot_pkey" PRIMARY KEY("scope","ring","slot_index"),
	CONSTRAINT "shadow_ledger_slot_scope_valid" CHECK ("shadow_ledger_slot"."scope" ~ '^shadow:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "shadow_ledger_slot_ring_valid" CHECK ("shadow_ledger_slot"."ring" IN ('wallet', 'new-payee') OR "shadow_ledger_slot"."ring" ~ '^cp:0x[0-9a-f]{40}$'),
	CONSTRAINT "shadow_ledger_slot_index_range" CHECK ("shadow_ledger_slot"."slot_index" >= 0 AND "shadow_ledger_slot"."slot_index" <= 90),
	CONSTRAINT "shadow_ledger_slot_index_matches_day" CHECK ("shadow_ledger_slot"."slot_index" = "shadow_ledger_slot"."day_index" % 91),
	CONSTRAINT "shadow_ledger_slot_day_index_range" CHECK ("shadow_ledger_slot"."day_index" >= 0 AND "shadow_ledger_slot"."day_index" <= 4294967295),
	CONSTRAINT "shadow_ledger_slot_amount_range" CHECK ("shadow_ledger_slot"."amount" >= 0 AND "shadow_ledger_slot"."amount" <= 26959946667150639794667015087019630673637144422540572481103610249215)
);
--> statement-breakpoint
ALTER TABLE "shadow_api_key" ADD CONSTRAINT "shadow_api_key_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_api_key" ADD CONSTRAINT "shadow_api_key_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_ledger_counterparty" ADD CONSTRAINT "shadow_ledger_counterparty_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_ledger_slot" ADD CONSTRAINT "shadow_ledger_slot_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_api_key_active_unique" ON "shadow_api_key" USING btree ("customer_id") WHERE revoked_at IS NULL;--> statement-breakpoint
-- App role grants (Story 3.4, AD-7, AD-25). API keys are revoked by UPDATE (never deleted); the virtual ledger rows are
-- mutable. Never DELETE or TRUNCATE.
REVOKE ALL ON TABLE "shadow_api_key" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "shadow_api_key" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "shadow_ledger_counterparty" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "shadow_ledger_counterparty" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "shadow_ledger_slot" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "shadow_ledger_slot" TO horos_app;
