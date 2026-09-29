// Dependency-boundary lint (AD-1, AD-12).
//
// Checks two sources for every workspace a rule covers:
//   1. declared dependencies in package.json
//   2. import specifiers in source files (static, `import type`, re-exports,
//      side-effect imports, dynamic `import()`, `require()`, subpaths)
//
// The rule table below is the single place the boundaries are defined.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * @typedef {object} Rule
 * @property {string} id           short rule name used in messages
 * @property {string} description  human-readable statement of the rule
 * @property {string[]} from       workspace directories (relative to repo root) the rule covers
 * @property {RegExp} [forbid]     specifiers matching this are violations
 * @property {RegExp} [allowOnly]  specifiers NOT matching this (and not relative) are violations
 * @property {RegExp} [testAllow]  extra specifiers allowed in test files only (allowOnly rules)
 */

/** @type {Rule[]} */
export const RULES = [
  {
    id: "no-owner",
    description: "sdk, mcp, skill, pipeline, adapters, the services and apps/log must never depend on or import @horos/owner",
    from: [
      "packages/sdk",
      "packages/mcp",
      "packages/skill",
      "packages/pipeline",
      "packages/adapters",
      "services/api",
      "services/worker",
      "apps/log",
    ],
    forbid: /^@horos\/owner(\/|$)/,
  },
  {
    id: "core-only-schema",
    description: "packages/core may depend on and import only @horos/schema or relative paths",
    from: ["packages/core"],
    allowOnly: /^@horos\/schema(\/|$)/,
    testAllow: /^(?:vitest|fast-check)(\/|$)/,
  },
];

/** Dependency fields that ship with the package (runtime or consumer-visible). */
const RUNTIME_DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];
const ALL_DEP_FIELDS = [...RUNTIME_DEP_FIELDS, "devDependencies"];

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".next", "out", "coverage", "build"]);

/**
 * Extract every module specifier with its 1-based line number, using the
 * TypeScript pre-processor (handles comments, strings, regex literals, JSX,
 * `import type`, re-exports, dynamic `import()` with attributes and `require()`).
 * @param {string} source
 * @returns {{ specifier: string, line: number }[]}
 */
export function extractSpecifiers(source) {
  const { importedFiles } = ts.preProcessFile(source, true, true);
  return importedFiles
    .map((f) => ({ specifier: f.fileName, pos: f.pos }))
    .sort((a, b) => a.pos - b.pos)
    .map(({ specifier, pos }) => ({ specifier, line: source.slice(0, pos).split("\n").length }));
}

/** @param {string} dir @returns {string[]} */
function listSourceFiles(dir) {
  /** @type {string[]} */
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      files.push(...listSourceFiles(join(dir, entry.name)));
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

/** @param {string} spec */
const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";

/**
 * @param {Rule} rule
 * @param {string} spec
 * @param {boolean} inTest
 * @returns {boolean} true when the specifier breaks the rule
 */
function violates(rule, spec, inTest) {
  if (rule.forbid) return rule.forbid.test(spec);
  if (rule.allowOnly) {
    if (isRelative(spec) || rule.allowOnly.test(spec)) return false;
    if (inTest && rule.testAllow?.test(spec)) return false;
    return true;
  }
  return false;
}

/**
 * @typedef {object} Violation
 * @property {string} rule
 * @property {string} file      path relative to the repo root
 * @property {number} [line]
 * @property {string} specifier
 * @property {string} message
 */

/**
 * Run every rule against a repo tree.
 * @param {string} rootDir
 * @param {Rule[]} [rules]
 * @returns {Violation[]}
 */
export function lint(rootDir, rules = RULES) {
  /** @type {Violation[]} */
  const violations = [];
  const rel = (/** @type {string} */ p) => relative(rootDir, p).split(sep).join("/");

  for (const rule of rules) {
    for (const ws of rule.from) {
      const wsDir = join(rootDir, ws);
      if (!existsSync(wsDir)) {
        violations.push({
          rule: rule.id,
          file: ws,
          specifier: "",
          message: `${ws}: covered workspace missing (renamed or wrong root?) [${rule.id}: ${rule.description}]`,
        });
        continue;
      }

      const pkgPath = join(wsDir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        // forbid rules cover every field (a devDependency on owner is still a leak);
        // allowOnly rules cover what ships, since dev tooling lives at the root.
        const fields = rule.forbid ? ALL_DEP_FIELDS : RUNTIME_DEP_FIELDS;
        for (const field of fields) {
          for (const dep of Object.keys(pkg[field] ?? {})) {
            if (violates(rule, dep, false)) {
              violations.push({
                rule: rule.id,
                file: rel(pkgPath),
                specifier: dep,
                message: `${rel(pkgPath)}: ${field} declares "${dep}" [${rule.id}: ${rule.description}]`,
              });
            }
          }
        }
        if (rule.allowOnly && pkg.devDependencies) {
          for (const dep of Object.keys(pkg.devDependencies)) {
            if (!rule.allowOnly.test(dep) && !rule.testAllow?.test(dep)) {
              violations.push({
                rule: rule.id,
                file: rel(pkgPath),
                specifier: dep,
                message: `${rel(pkgPath)}: devDependencies declares "${dep}"; put tooling in the root package.json [${rule.id}: ${rule.description}]`,
              });
            }
          }
        }
      }

      for (const file of listSourceFiles(wsDir)) {
        const inTest = TEST_FILE.test(rel(file));
        for (const { specifier, line } of extractSpecifiers(readFileSync(file, "utf8"))) {
          if (isRelative(specifier)) {
            const target = resolve(dirname(file), specifier);
            if (target !== wsDir && !target.startsWith(wsDir + sep)) {
              violations.push({
                rule: rule.id,
                file: rel(file),
                line,
                specifier,
                message: `${rel(file)}:${line}: cross-workspace relative import "${specifier}" leaves ${ws} [${rule.id}: ${rule.description}]`,
              });
            }
            continue;
          }
          if (violates(rule, specifier, inTest)) {
            violations.push({
              rule: rule.id,
              file: rel(file),
              line,
              specifier,
              message: `${rel(file)}:${line}: imports "${specifier}" [${rule.id}: ${rule.description}]`,
            });
          }
        }
      }
    }
  }
  return violations;
}
