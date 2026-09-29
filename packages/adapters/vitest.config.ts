import { defineConfig } from "vitest/config";

// PGlite-backed tests build a fresh database per test; under full-repo parallel load (lint + typecheck + build + test
// at once) they can exceed vitest's 5s default, and even 30s.
export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
