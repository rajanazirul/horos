// Runs the built `horos-verify` binary as a real process, so the entrypoint guard and the exit code
// path are exercised. `test` depends on this package's own `build` (tools/verify/turbo.json).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { chainLines } from "./chain.test-helpers.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "horos-verify-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("horos-verify binary (dist/cli.js)", () => {
  test("is built", () => expect(existsSync(CLI)).toBe(true));

  test("exit 0 for a valid chain", () => {
    const file = join(dir, "ok.jsonl");
    writeFileSync(file, `${chainLines(3).join("\n")}\n`);
    const r = run(file);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, count: 3 });
  });

  test("exit 1 and prints the break for a tampered chain", () => {
    const lines = chainLines(3);
    const obj = JSON.parse(lines[1] ?? "") as { record: { reason: string } };
    obj.record.reason = "Allowed: edited.";
    lines[1] = JSON.stringify(obj);
    const file = join(dir, "tampered.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const r = run(file);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ ok: false, firstBreak: { line: 2, seq: 1, reason: "hash mismatch" } });
  });

  test("exit 2 for a missing file", () => {
    const r = run(join(dir, "missing.jsonl"));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/cannot read/);
  });
});
