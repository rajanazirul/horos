CREATE TABLE "job" (
	"kind" text NOT NULL,
	"window" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "job_pkey" PRIMARY KEY("kind","window"),
	CONSTRAINT "job_status_valid" CHECK ("job"."status" IN ('pending', 'running', 'done', 'failed')),
	CONSTRAINT "job_attempts_nonnegative" CHECK ("job"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "list_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"content_hash" text NOT NULL,
	"entries" jsonb NOT NULL,
	"address_count" integer NOT NULL,
	"status" text NOT NULL,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "list_snapshot_source_content_hash_status_unique" UNIQUE("source","content_hash","status"),
	CONSTRAINT "list_snapshot_source_valid" CHECK ("list_snapshot"."source" IN ('ofac-sdn', 'horos-demo-list')),
	CONSTRAINT "list_snapshot_content_hash_valid" CHECK ("list_snapshot"."content_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "list_snapshot_status_valid" CHECK ("list_snapshot"."status" IN ('active', 'quarantined')),
	CONSTRAINT "list_snapshot_address_count_nonnegative" CHECK ("list_snapshot"."address_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "list_source" (
	"source" text PRIMARY KEY NOT NULL,
	"last_verified_at" timestamp (3) with time zone,
	"last_modified" text,
	"active_snapshot_id" uuid,
	"quarantine_alerted_hash" text,
	CONSTRAINT "list_source_source_valid" CHECK ("list_source"."source" IN ('ofac-sdn', 'horos-demo-list'))
);
--> statement-breakpoint
ALTER TABLE "list_snapshot" ADD CONSTRAINT "list_snapshot_source_list_source_source_fk" FOREIGN KEY ("source") REFERENCES "public"."list_source"("source") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_source" ADD CONSTRAINT "list_source_active_snapshot_id_list_snapshot_id_fk" FOREIGN KEY ("active_snapshot_id") REFERENCES "public"."list_snapshot"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- App role grants (AD-14). horos_app already exists (0000). Snapshots are insert-only; list_source
-- (active pointer + freshness) and job rows are mutable, but never deleted by the app.
REVOKE ALL ON TABLE "list_snapshot" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "list_snapshot" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "list_source" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "list_source" TO horos_app;
--> statement-breakpoint
REVOKE ALL ON TABLE "job" FROM horos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "job" TO horos_app;
