import { defineConfig } from "vitest/config";

// Database tests copy a database on the test Postgres (docker compose up -d postgres-test) per test; under full-repo
// parallel load (lint + typecheck + build + test at once) they can exceed vitest's 5s default.
export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
