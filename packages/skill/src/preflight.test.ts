import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { main } from "./cli.js";
import { scanAndCleanTempRepos, io, KEY, tempRepo, tempHome } from "./harness.test-helpers.js";
import { isGitignored, preflight } from "./preflight.js";

afterAll(scanAndCleanTempRepos);

const deps = (root: string, env: Record<string, string> = {}) => ({ root, env, nodeVersion: "24.1.0" });

test("preflight ok: exit 0 and every check listed", async () => {
  const root = tempRepo();
  const r = preflight(deps(root));
  expect(r.ok).toBe(true);
  expect(r.checks.map((c) => c.name)).toEqual(["node", "package.json", "no @horos/owner", ".env* gitignored", ".env* not tracked by git", "Payment key in env", "api origin in env"]);
  const x = io();
  expect(await main(["preflight"], { root, env: { HOROS_PAYMENT_PRIVATE_KEY: KEY }, out: x.o, err: x.e, now: () => 0, nodeVersion: "24.1.0", home: tempHome() })).toBe(0);
  expect(x.all()).toMatch(/preflight passed/);
  expect(x.all()).toMatch(/HOROS_PAYMENT_PRIVATE_KEY is set \(value not shown\)/);
  expect(x.all()).not.toContain(KEY.slice(2));
});

test("Node before 20.12 fails", () => {
  expect(preflight({ ...deps(tempRepo()), nodeVersion: "18.20.0" }).ok).toBe(false);
  expect(preflight({ ...deps(tempRepo()), nodeVersion: "20.11.1" }).ok).toBe(false);
  expect(preflight({ ...deps(tempRepo()), nodeVersion: "20.12.0" }).ok).toBe(true);
});

test("@horos/owner in any dependency field: non-zero with the custody message", async () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const root = tempRepo({ pkg: { name: "agent", [field]: { "@horos/owner": "1.0.0" } } });
    const x = io();
    expect(await main(["preflight"], { root, env: {}, out: x.o, err: x.e, now: () => 0, nodeVersion: "24.1.0", home: tempHome() })).toBe(1);
    expect(x.all()).toMatch(/Human tooling must stay out of the agent repo/);
  }
});

test(".env not gitignored: non-zero and says what to add", async () => {
  for (const gitignore of [null, "node_modules/\n", ".env*\n!.env\n"]) {
    const root = tempRepo({ gitignore });
    const x = io();
    expect(await main(["preflight"], { root, env: {}, out: x.o, err: x.e, now: () => 0, nodeVersion: "24.1.0", home: tempHome() })).toBe(1);
    expect(x.all()).toMatch(/Add a line `\.env\*` to \.gitignore/);
  }
});

test("an existing .env.production must be ignored too; .env.example need not be", () => {
  const root = tempRepo({ gitignore: ".env\n.env.local\n" });
  writeFileSync(join(root, ".env.production"), "X=1\n");
  writeFileSync(join(root, ".env.example"), "X=\n");
  const r = preflight(deps(root));
  expect(r.ok).toBe(false);
  expect(r.checks.find((c) => c.name === ".env* gitignored")?.detail).toMatch(/\.env\.production/);
});

test("no package.json: fails", () => {
  const root = tempRepo();
  writeFileSync(join(root, "package.json"), "not json");
  expect(preflight(deps(root)).ok).toBe(false);
});

test("gitignore matcher", () => {
  expect(isGitignored(".env*\n", ".env")).toBe(true);
  expect(isGitignored("/.env*\n", ".env.local")).toBe(true);
  expect(isGitignored("**/.env*\n", ".env.local")).toBe(true);
  expect(isGitignored(".env.*\n", ".env")).toBe(false);
  expect(isGitignored("*.env\n", ".env")).toBe(true);
  expect(isGitignored(".env*\n!.env.example\n", ".env.example")).toBe(false);
  expect(isGitignored("# .env\n", ".env")).toBe(false);
  expect(isGitignored("config/.env\n", ".env")).toBe(false);
  // Directory-only rules never match a file, only its parent directories.
  expect(isGitignored(".env*/\n", ".env")).toBe(false);
  expect(isGitignored("secrets/\n", "secrets/.env")).toBe(true);
  // Nested files: unanchored patterns match the basename at any depth; anchored ones only from the root.
  expect(isGitignored(".env*\n", "apps/bot/.env")).toBe(true);
  expect(isGitignored("/.env*\n", "apps/bot/.env")).toBe(false);
  expect(isGitignored("apps/**/.env\n", "apps/bot/.env")).toBe(true);
});

test("nested .env files must be gitignored too (node_modules and .git are skipped)", () => {
  const root = tempRepo({ gitignore: "/.env*\n" });
  mkdirSync(join(root, "apps/bot"), { recursive: true });
  writeFileSync(join(root, "apps/bot/.env"), "X=1\n");
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules/pkg/.env"), "X=1\n");
  const detail = preflight(deps(root)).checks.find((c) => c.name === ".env* gitignored")?.detail ?? "";
  expect(detail).toMatch(/apps\/bot\/\.env/);
  expect(detail).not.toMatch(/node_modules/);
});

test("an .env file already tracked by git fails even when gitignored", () => {
  const root = tempRepo();
  writeFileSync(join(root, ".env"), "X=1\n");
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  expect(git("init", "-q").status).toBe(0);
  expect(git("add", "-f", ".env", "package.json").status).toBe(0);
  const r = preflight(deps(root));
  expect(r.ok).toBe(false);
  expect(r.checks.find((c) => c.name === ".env* not tracked by git")?.detail).toMatch(/tracked by git: \.env\. Run `git rm --cached/);
  // Outside a git work tree the check is skipped.
  expect(preflight({ ...deps(tempRepo()), gitTrackedFiles: () => null }).ok).toBe(true);
});

test("@horos/owner via an npm alias, nested pnpm.overrides, or installed in node_modules fails", () => {
  const cases: Record<string, unknown>[] = [
    { name: "a", dependencies: { human: "npm:@horos/owner@1.0.0" } },
    { name: "a", pnpm: { overrides: { "foo>@horos/owner": "1.0.0" } } },
    { name: "a", overrides: { foo: { "@horos/owner": "1.0.0" } } },
  ];
  for (const pkg of cases) expect(preflight(deps(tempRepo({ pkg }))).ok, JSON.stringify(pkg)).toBe(false);
  const root = tempRepo();
  mkdirSync(join(root, "node_modules/@horos/owner"), { recursive: true });
  const r = preflight(deps(root));
  expect(r.ok).toBe(false);
  expect(r.checks.find((c) => c.name === "no @horos/owner")?.detail).toMatch(/node_modules\/@horos\/owner \(installed\)/);
});
