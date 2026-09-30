// Test-only entry point (`@horos/adapters/testing`): throwaway databases on the test Postgres server. Never imported
// by service code.
export { emptyDb, freshDb, seededTemplate, testDatabaseUrl, testServerUrl, type DbTemplate, type TestClient } from "./postgres/test-db.js";
