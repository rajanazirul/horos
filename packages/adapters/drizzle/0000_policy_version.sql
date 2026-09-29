CREATE TABLE "policy_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"seq" integer NOT NULL,
	"parent_id" uuid,
	"preset_version" text NOT NULL,
	"activation" text NOT NULL,
	"policy" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_version_scope_seq_unique" UNIQUE("scope","seq"),
	CONSTRAINT "policy_version_seq_positive" CHECK ("policy_version"."seq" >= 1),
	CONSTRAINT "policy_version_activation_valid" CHECK ("policy_version"."activation" IN ('preset', 'tighter-proof'))
);
--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_parent_id_policy_version_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."policy_version"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- App role (AD-14): created without login; Story 2.10 attaches one. Idempotent. No passwords here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'horos_app') THEN
    CREATE ROLE horos_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- PolicyVersions are insert-only for the app: SELECT and INSERT, never UPDATE, DELETE or TRUNCATE.
REVOKE ALL ON TABLE "policy_version" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "policy_version" TO horos_app;
