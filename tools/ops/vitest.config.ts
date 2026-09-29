import { defineConfig } from "vitest/config";

// PGlite databases are migrated per test; under full-repo parallel load that can exceed vitest's 5s default.
export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
