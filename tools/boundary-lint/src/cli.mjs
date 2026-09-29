#!/usr/bin/env node
// Usage: node tools/boundary-lint/src/cli.mjs [repoRoot]
// Exits 1 and prints one line per violation when any boundary rule is broken.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "./lint.mjs";

const defaultRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const root = resolve(process.argv[2] ?? defaultRoot);
const violations = lint(root);

if (violations.length > 0) {
  console.error(`boundary-lint: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v.message}`);
  process.exit(1);
}
console.log("boundary-lint: no violations");
