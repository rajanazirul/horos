CREATE TABLE "account_nonce" (
	"payment_address" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "account_nonce_pkey" PRIMARY KEY("payment_address","nonce"),
	CONSTRAINT "account_nonce_nonce_valid" CHECK ("account_nonce"."nonce" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_address" text NOT NULL,
	"category" text DEFAULT 'own-test' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_payment_address_unique" UNIQUE("payment_address"),
	CONSTRAINT "customer_payment_address_valid" CHECK ("customer"."payment_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "customer_category_valid" CHECK ("customer"."category" IN ('own-test', 'other-team-test', 'real-business'))
);
--> statement-breakpoint
CREATE TABLE "customer_webhook" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "customer_webhook_url_length" CHECK (char_length("customer_webhook"."url") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "enforced_binding" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"scope_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"policy_wallet" text,
	"registrar" text,
	"model" text,
	"rules" text,
	"circle_wallet_set_id" text,
	"circle_registrar_wallet_id" text,
	"circle_model_wallet_id" text,
	"circle_rules_wallet_id" text,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "enforced_binding_scope_id_unique" UNIQUE("scope_id"),
	CONSTRAINT "enforced_binding_policy_wallet_unique" UNIQUE("policy_wallet"),
	CONSTRAINT "enforced_binding_status_valid" CHECK ("enforced_binding"."status" IN ('pending', 'bound')),
	CONSTRAINT "enforced_binding_scope_id_valid" CHECK ("enforced_binding"."scope_id" ~ '^enforced:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "enforced_binding_bound_has_wallet" CHECK ("enforced_binding"."status" <> 'bound' OR "enforced_binding"."policy_wallet" IS NOT NULL),
	CONSTRAINT "enforced_binding_addresses_valid" CHECK (("enforced_binding"."policy_wallet" IS NULL OR "enforced_binding"."policy_wallet" ~ '^0x[0-9a-f]{40}$') AND ("enforced_binding"."registrar" IS NULL OR "enforced_binding"."registrar" ~ '^0x[0-9a-f]{40}$') AND ("enforced_binding"."model" IS NULL OR "enforced_binding"."model" ~ '^0x[0-9a-f]{40}$') AND ("enforced_binding"."rules" IS NULL OR "enforced_binding"."rules" ~ '^0x[0-9a-f]{40}$'))
);
--> statement-breakpoint
CREATE TABLE "outbox_intent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"counterparty" text NOT NULL,
	"lane_role" text NOT NULL,
	"target" numeric(38, 0) NOT NULL,
	"pin" boolean DEFAULT false NOT NULL,
	"human_epoch" numeric NOT NULL,
	"record_ids" uuid[] NOT NULL,
	"created_by_record" uuid NOT NULL,
	"send_record_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone NOT NULL,
	"alerted" boolean DEFAULT false NOT NULL,
	"circle_tx_id" text,
	"tx_hash" text,
	"last_error" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "outbox_intent_status_valid" CHECK ("outbox_intent"."status" IN ('pending', 'sending', 'submitted', 'confirmed', 'noop', 'failed')),
	CONSTRAINT "outbox_intent_lane_role_valid" CHECK ("outbox_intent"."lane_role" IN ('registrar', 'rules')),
	CONSTRAINT "outbox_intent_counterparty_valid" CHECK ("outbox_intent"."counterparty" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "outbox_intent_send_record_hash_valid" CHECK ("outbox_intent"."send_record_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "outbox_intent_target_nonnegative" CHECK ("outbox_intent"."target" >= 0),
	CONSTRAINT "outbox_intent_pin_target_zero" CHECK (NOT "outbox_intent"."pin" OR "outbox_intent"."target" = 0),
	CONSTRAINT "outbox_intent_attempts_nonnegative" CHECK ("outbox_intent"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customer_webhook" ADD CONSTRAINT "customer_webhook_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforced_binding" ADD CONSTRAINT "enforced_binding_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_intent" ADD CONSTRAINT "outbox_intent_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_webhook_customer_created_idx" ON "customer_webhook" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_intent_pending_unique" ON "outbox_intent" USING btree ("scope","counterparty") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_intent_lane_idx" ON "outbox_intent" USING btree ("scope","lane_role","status");--> statement-breakpoint
-- App role grants (AD-8, AD-14, AD-15, AD-25). horos_app already exists (0000). Customers, webhooks and
-- account nonces are insert-only for the app; the binding and outbox rows are mutable. Never DELETE or TRUNCATE.
REVOKE ALL ON TABLE "customer" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "customer" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "customer_webhook" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "customer_webhook" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "enforced_binding" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "enforced_binding" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "outbox_intent" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "outbox_intent" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "account_nonce" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "account_nonce" TO horos_app;
