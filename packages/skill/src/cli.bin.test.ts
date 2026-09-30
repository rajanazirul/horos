// Runs the built `horos-quickstart` binary as a real process. `test` depends on this package's own `build`
// (packages/skill/turbo.json).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { KEY, scanAndCleanTempRepos, tempRepo } from "./harness.test-helpers.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Temp agent repos go through the same secret scan as every other test's files. */
const repo = () => tempRepo({ pkg: { name: "agent", version: "1.0.0" } });

function run(args: string[], cwd: string) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HOROS_")));
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: clean, timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

afterAll(scanAndCleanTempRepos);

describe("horos-quickstart binary (dist/cli.js)", () => {
  test("is built, with the Demo List bundled", () => {
    expect(existsSync(CLI)).toBe(true);
    expect(existsSync(fileURLToPath(new URL("../dist/horos-demo-list.json", import.meta.url)))).toBe(true);
  });

  test("preflight in a clean temp repo exits 0", () => {
    const r = run(["preflight"], repo());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^preflight passed:/);
  });

  test("deploy --human <64-hex> is refused and the value is never printed", () => {
    for (const v of [KEY, KEY.slice(2)]) {
      const cwd = repo();
      const r = run(["deploy", "--human", v], cwd);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/looks like a private key/);
      expect(`${r.out}${r.err}`.toLowerCase()).not.toContain(KEY.slice(2));
      expect(existsSync(join(cwd, "horos.config.json"))).toBe(false);
    }
  });
});
