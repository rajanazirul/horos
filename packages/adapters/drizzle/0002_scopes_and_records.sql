CREATE TABLE "decision_record" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"seq" integer NOT NULL,
	"prev_hash" text NOT NULL,
	"record_hash" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "decision_record_record_hash_unique" UNIQUE("record_hash"),
	CONSTRAINT "decision_record_scope_seq_unique" UNIQUE("scope","seq"),
	CONSTRAINT "decision_record_scope_prev_hash_unique" UNIQUE("scope","prev_hash"),
	CONSTRAINT "decision_record_seq_nonnegative" CHECK ("decision_record"."seq" >= 0),
	CONSTRAINT "decision_record_prev_hash_valid" CHECK ("decision_record"."prev_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "decision_record_record_hash_valid" CHECK ("decision_record"."record_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "record_chain_head" (
	"scope" text PRIMARY KEY NOT NULL,
	"next_seq" integer NOT NULL,
	"head_hash" text NOT NULL,
	CONSTRAINT "record_chain_head_next_seq_nonnegative" CHECK ("record_chain_head"."next_seq" >= 0),
	CONSTRAINT "record_chain_head_head_hash_valid" CHECK ("record_chain_head"."head_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "scope" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"customer_id" uuid,
	"policy_wallet" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_kind_valid" CHECK ("scope"."kind" IN ('enforced', 'shadow', 'advisory-public')),
	CONSTRAINT "scope_id_matches_kind" CHECK (CASE "scope"."kind" WHEN 'advisory-public' THEN "scope"."id" = 'advisory-public' ELSE "scope"."id" ~ ('^' || "scope"."kind" || ':[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') END),
	CONSTRAINT "scope_enforced_has_policy_wallet" CHECK ("scope"."kind" <> 'enforced' OR "scope"."policy_wallet" IS NOT NULL),
	CONSTRAINT "scope_shadow_has_customer" CHECK ("scope"."kind" <> 'shadow' OR "scope"."customer_id" IS NOT NULL),
	CONSTRAINT "scope_policy_wallet_valid" CHECK ("scope"."policy_wallet" IS NULL OR "scope"."policy_wallet" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "used_nonce" (
	"scope" text NOT NULL,
	"nonce" text NOT NULL,
	"record_id" uuid NOT NULL,
	CONSTRAINT "used_nonce_pkey" PRIMARY KEY("scope","nonce"),
	CONSTRAINT "used_nonce_nonce_valid" CHECK ("used_nonce"."nonce" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "decision_record" ADD CONSTRAINT "decision_record_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_chain_head" ADD CONSTRAINT "record_chain_head_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "used_nonce" ADD CONSTRAINT "used_nonce_scope_scope_id_fk" FOREIGN KEY ("scope") REFERENCES "public"."scope"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "used_nonce" ADD CONSTRAINT "used_nonce_record_id_decision_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."decision_record"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- App role grants (AD-9, AD-14, AD-25). horos_app already exists (0000). Records, nonces and Scopes are
-- insert-only for the app; the chain head is the only mutable row here. Never DELETE or TRUNCATE.
REVOKE ALL ON TABLE "scope" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "scope" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "record_chain_head" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "record_chain_head" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "decision_record" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "decision_record" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "used_nonce" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "used_nonce" TO horos_app;
