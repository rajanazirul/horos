import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { extractSpecifiers, lint } from "../src/lint.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** @type {string[]} */
const made = [];
afterEach(() => {
  while (made.length) rmSync(/** @type {string} */ (made.pop()), { recursive: true, force: true });
});

/**
 * Build a fixture repo: a clean baseline of every covered workspace, plus overrides.
 * @param {Record<string, string | object>} files path -> contents (objects are JSON-encoded)
 */
function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "boundary-lint-"));
  made.push(root);
  /** @type {Record<string, string | object>} */
  const base = {
    "packages/schema/package.json": { name: "@horos/schema" },
    "packages/schema/src/index.ts": 'import { z } from "zod";\nexport const s = z;\n',
    "packages/core/package.json": { name: "@horos/core", dependencies: { "@horos/schema": "workspace:*" } },
    "packages/core/src/index.ts": 'export const CORE = "core";\n',
    "packages/core/src/index.test.ts": 'import { test } from "vitest";\nimport { CORE } from "./index.js";\ntest("x", () => void CORE);\n',
    "packages/owner/package.json": { name: "@horos/owner" },
    "packages/owner/src/index.ts": "export const OWNER = 1;\n",
    "packages/sdk/package.json": { name: "@horos/sdk", dependencies: { "@horos/schema": "workspace:*" } },
    "packages/sdk/src/index.ts": 'import "@horos/schema";\n',
    "packages/mcp/package.json": { name: "@horos/mcp", dependencies: { "@horos/sdk": "workspace:*" } },
    "packages/mcp/src/index.ts": 'export * from "@horos/sdk";\n',
    "packages/skill/package.json": { name: "@horos/skill" },
    "packages/pipeline/package.json": { name: "@horos/pipeline", dependencies: { "@horos/core": "workspace:*" } },
    "packages/adapters/package.json": { name: "@horos/adapters", dependencies: { "@horos/core": "workspace:*" } },
    "apps/log/package.json": { name: "@horos/log", dependencies: { "@horos/sdk": "workspace:*" } },
    "services/api/package.json": { name: "@horos/api", dependencies: { "@horos/pipeline": "workspace:*" } },
    "services/api/src/index.ts": 'const p = await import("@horos/pipeline");\nexport default p;\n',
    "services/worker/package.json": { name: "@horos/worker" },
    "services/worker/src/index.ts": 'const x = require("@horos/adapters");\nexport default x;\n',
    ...files,
  };
  for (const [path, contents] of Object.entries(base)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return root;
}

/** @param {string} root */
function runCli(root) {
  return spawnSync(process.execPath, [CLI, root], { encoding: "utf8" });
}

describe("I/O matrix", () => {
  test("clean workspace exits 0", () => {
    const root = fixture();
    expect(lint(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  });

  test("sdk imports owner: exit 1, message names the file and the rule", () => {
    const root = fixture({ "packages/sdk/src/x.ts": 'import "@horos/owner";\n' });
    const v = lint(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "no-owner", file: "packages/sdk/src/x.ts", line: 1, specifier: "@horos/owner" });
    const res = runCli(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("packages/sdk/src/x.ts:1");
    expect(res.stderr).toContain("no-owner");
  });

  test("service declares owner: exit 1", () => {
    const root = fixture({
      "services/api/package.json": { name: "@horos/api", dependencies: { "@horos/owner": "workspace:*" } },
    });
    const v = lint(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "no-owner", file: "services/api/package.json", specifier: "@horos/owner" });
    expect(runCli(root).status).toBe(1);
  });

  test("owner as a devDependency is still a violation", () => {
    const root = fixture({
      "services/worker/package.json": { name: "@horos/worker", devDependencies: { "@horos/owner": "workspace:*" } },
    });
    expect(lint(root)).toHaveLength(1);
  });

  test("core imports zod: exit 1", () => {
    const root = fixture({ "packages/core/src/x.ts": 'import { z } from "zod";\nexport const y = z;\n' });
    const v = lint(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "core-only-schema", file: "packages/core/src/x.ts", specifier: "zod" });
    expect(runCli(root).status).toBe(1);
  });

  test("core declares zod: exit 1", () => {
    const root = fixture({
      "packages/core/package.json": { name: "@horos/core", dependencies: { "@horos/schema": "workspace:*", zod: "4.6.5" } },
    });
    expect(lint(root).map((v) => v.specifier)).toEqual(["zod"]);
  });

  test("core imports a node builtin: exit 1 (core performs no I/O)", () => {
    const root = fixture({ "packages/core/src/x.ts": 'import { readFileSync } from "node:fs";\nexport { readFileSync };\n' });
    expect(lint(root).map((v) => v.specifier)).toEqual(["node:fs"]);
  });

  test("core imports schema or a relative path: exit 0", () => {
    const root = fixture({
      "packages/core/src/x.ts": [
        'import { s } from "@horos/schema";',
        'import type { T } from "@horos/schema/types";',
        'import { u } from "./util";',
        'import { v } from "../ports/index.js";',
        "export { s, u, v };",
        "export type { T };",
      ].join("\n"),
    });
    expect(lint(root)).toEqual([]);
    expect(runCli(root).status).toBe(0);
  });

  test("vitest is allowed in core test files only", () => {
    const root = fixture({ "packages/core/src/x.ts": 'import { test } from "vitest";\nexport { test };\n' });
    expect(lint(root).map((v) => v.file)).toEqual(["packages/core/src/x.ts"]);
  });

  test("subpath type import of owner in mcp: exit 1", () => {
    const root = fixture({ "packages/mcp/src/x.ts": 'import type {X} from "@horos/owner/sub";\nexport type { X };\n' });
    const v = lint(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "no-owner", specifier: "@horos/owner/sub" });
    expect(runCli(root).status).toBe(1);
  });

  test.each([
    ["skill dynamic import", "packages/skill/src/x.ts", 'export const o = await import("@horos/owner");\n'],
    ["worker require", "services/worker/src/x.cjs", 'module.exports = require("@horos/owner");\n'],
    ["sdk re-export", "packages/sdk/src/x.ts", 'export { OWNER } from "@horos/owner";\n'],
    ["api multi-line import", "services/api/src/x.ts", 'import {\n  OWNER,\n} from "@horos/owner";\nexport { OWNER };\n'],
  ])("%s of owner: exit 1", (_name, path, src) => {
    const root = fixture({ [path]: src });
    expect(lint(root).map((v) => v.specifier)).toEqual(["@horos/owner"]);
  });

  test("owner imported by an uncovered workspace is fine", () => {
    const root = fixture({ "tools/verify/src/x.ts": 'import "@horos/owner";\n' });
    expect(lint(root)).toEqual([]);
  });

  test("lookalike package names are not owner", () => {
    const root = fixture({ "packages/sdk/src/x.ts": 'import "@horos/owners";\nimport "@horos/owner-tools";\n' });
    expect(lint(root)).toEqual([]);
  });

  test.each(["devDependencies", "peerDependencies", "optionalDependencies"])("core declares zod in %s: violation", (field) => {
    const root = fixture({
      "packages/core/package.json": { name: "@horos/core", dependencies: { "@horos/schema": "workspace:*" }, [field]: { zod: "4.6.5" } },
    });
    expect(lint(root).map((v) => v.specifier)).toEqual(["zod"]);
  });

  test("core devDependencies on vitest is allowed", () => {
    const root = fixture({
      "packages/core/package.json": { name: "@horos/core", dependencies: { "@horos/schema": "workspace:*" }, devDependencies: { vitest: "5.0.1" } },
    });
    expect(lint(root)).toEqual([]);
  });

  test("core devDependencies on fast-check is allowed", () => {
    const root = fixture({
      "packages/core/package.json": {
        name: "@horos/core",
        dependencies: { "@horos/schema": "workspace:*" },
        devDependencies: { "fast-check": "4.10.2" },
      },
    });
    expect(lint(root)).toEqual([]);
  });

  test("fast-check is allowed in core test files only", () => {
    const root = fixture({
      "packages/core/src/p.test.ts": 'import fc from "fast-check";\nexport { fc };\n',
      "packages/core/src/x.ts": 'import fc from "fast-check";\nexport { fc };\n',
    });
    expect(lint(root).map((v) => v.file)).toEqual(["packages/core/src/x.ts"]);
  });

  test("core declares fast-check as a runtime dependency: violation", () => {
    const root = fixture({
      "packages/core/package.json": { name: "@horos/core", dependencies: { "@horos/schema": "workspace:*", "fast-check": "4.10.2" } },
    });
    expect(lint(root).map((v) => v.specifier)).toEqual(["fast-check"]);
  });

  test.each(["peerDependencies", "optionalDependencies"])("sdk declares owner in %s: one violation", (field) => {
    const root = fixture({ "packages/sdk/package.json": { name: "@horos/sdk", [field]: { "@horos/owner": "workspace:*" } } });
    const v = lint(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "no-owner", file: "packages/sdk/package.json", specifier: "@horos/owner" });
  });

  test.each([
    ["pipeline", "packages/pipeline/src/x.ts"],
    ["adapters", "packages/adapters/src/x.ts"],
    ["apps/log", "apps/log/src/x.ts"],
  ])("%s imports owner: violation", (_name, path) => {
    const root = fixture({ [path]: 'import "@horos/owner";\n' });
    expect(lint(root).map((v) => v.rule)).toEqual(["no-owner"]);
  });

  test.each([
    ["regex literal with a quote", "packages/sdk/src/x.ts", "const re = /'/;\nimport \"@horos/owner\";\n"],
    ["regex literal with //", "packages/sdk/src/x.ts", "const re = /\\/\\//;\nimport \"@horos/owner\";\n"],
    ["JSX apostrophe", "packages/sdk/src/x.tsx", "export const A = () => <p>don't</p>;\nimport \"@horos/owner\";\n"],
    ["import-attributes dynamic import", "packages/sdk/src/x.ts", 'export const o = await import("@horos/owner", { with: { type: "json" } });\n'],
    ["hand-written .d.ts", "packages/sdk/src/types.d.ts", 'import type { X } from "@horos/owner";\nexport type { X };\n'],
  ])("%s followed by an owner import is caught", (_name, path, src) => {
    const root = fixture({ [path]: src });
    expect(lint(root).map((v) => v.specifier)).toEqual(["@horos/owner"]);
  });

  test.each([
    ["sdk reaches into owner", "packages/sdk/src/x.ts", 'import { OWNER } from "../../owner/src/index.js";\nexport { OWNER };\n'],
    ["core reaches into pipeline", "packages/core/src/x.ts", 'import "../../../packages/pipeline/src";\n'],
  ])("cross-workspace relative import (%s): violation", (_name, path, src) => {
    const root = fixture({ [path]: src });
    const v = lint(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("cross-workspace relative import");
    expect(runCli(root).status).toBe(1);
  });

  test("a vitest import in a src/test/ helper of core is a violation", () => {
    const root = fixture({ "packages/core/src/test/helper.ts": 'import { expect } from "vitest";\nexport { expect };\n' });
    expect(lint(root).map((v) => v.specifier)).toEqual(["vitest"]);
  });

  test("a missing covered workspace is reported", () => {
    const root = fixture();
    rmSync(join(root, "packages/skill"), { recursive: true, force: true });
    const v = lint(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("covered workspace missing");
    expect(runCli(root).status).toBe(1);
  });

  test("commented-out imports are ignored", () => {
    const root = fixture({
      "packages/sdk/src/x.ts": '// import "@horos/owner";\n/* import { X } from "@horos/owner"; */\nexport {};\n',
    });
    expect(lint(root)).toEqual([]);
  });
});

describe("extractSpecifiers", () => {
  test("reports line numbers for each form", () => {
    const src = [
      'import a from "a";',
      'import type { B } from "b";',
      'import "c";',
      'export * from "d";',
      'const e = await import("e");',
      'const f = require("f");',
    ].join("\n");
    expect(extractSpecifiers(src)).toEqual([
      { specifier: "a", line: 1 },
      { specifier: "b", line: 2 },
      { specifier: "c", line: 3 },
      { specifier: "d", line: 4 },
      { specifier: "e", line: 5 },
      { specifier: "f", line: 6 },
    ]);
  });
});

test("the real repository has no boundary violations", () => {
  expect(lint(REPO_ROOT)).toEqual([]);
});
