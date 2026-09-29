-- Story 2.10: the api's /healthz answers 503 `schema-behind` until the applied migration count equals the bundled
-- journal, so the app role may read (never write) drizzle's migration table. The migrator creates the `drizzle`
-- schema and table before any migration runs, so both exist here.
GRANT USAGE ON SCHEMA drizzle TO horos_app;
--> statement-breakpoint
GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO horos_app;
