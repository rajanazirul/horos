import { describe, expect, test } from "vitest";
import { main, type CliIo } from "./cli.js";
import { chainLines } from "./chain.test-helpers.js";

function io(files: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readText: async (p) => {
      const t = files[p];
      if (t === undefined) throw new Error("ENOENT");
      return t;
    },
  };
  return { cli, out, err };
}

describe("horos-verify CLI", () => {
  test("exit 0 and prints the ok result for a valid chain", async () => {
    const { cli, out } = io({ "c.jsonl": `${chainLines(3).join("\n")}\n` });
    expect(await main(["c.jsonl"], cli)).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toEqual({ ok: true, count: 3 });
  });

  test("exit 1 on a break", async () => {
    const lines = chainLines(3);
    lines.splice(0, 1);
    const { cli, out } = io({ "c.jsonl": lines.join("\n") });
    expect(await main(["c.jsonl"], cli)).toBe(1);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({ ok: false, firstBreak: { line: 1, seq: 1 } });
  });

  test("exit 2 on usage or read errors", async () => {
    const { cli, err } = io({});
    expect(await main([], cli)).toBe(2);
    expect(await main(["a", "b"], cli)).toBe(2);
    expect(await main(["missing.jsonl"], cli)).toBe(2);
    expect(err.join("\n")).toMatch(/usage: horos-verify/);
    expect(err.join("\n")).toMatch(/cannot read missing.jsonl/);
  });
});
