-- Local dev roles for the `postgres` service in docker-compose.yml, created exactly like production
-- (docs/runbooks/railway-deploy.md step 2) with fixed dev-only passwords. Runs once, on an empty data volume.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'horos_app') THEN CREATE ROLE horos_app NOLOGIN; END IF;
END $$;
CREATE ROLE horos_api LOGIN PASSWORD 'horos-api-dev' IN ROLE horos_app;
CREATE ROLE horos_worker LOGIN PASSWORD 'horos-worker-dev' IN ROLE horos_app;
CREATE ROLE horos_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'horos-migrator-dev';
GRANT CREATE ON DATABASE horos TO horos_migrator;
GRANT CREATE ON SCHEMA public TO horos_migrator;
