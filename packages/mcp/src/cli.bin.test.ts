// Runs the built `horos-mcp` binary as a real process over stdio: stdout must carry JSON-RPC only, the banner goes to
// stderr. `test` depends on this package's own `build` (packages/mcp/turbo.json).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { TOOL_NAMES } from "./server.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const input = [
  { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bin-test", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 1, method: "tools/list" },
]
  .map((m) => JSON.stringify(m))
  .join("\n");

function run(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HOROS_")));
  const r = spawnSync(process.execPath, [CLI], { input: `${input}\n`, encoding: "utf8", env: { ...clean, ...env }, timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("horos-mcp binary (dist/cli.js)", () => {
  test("is built", () => expect(existsSync(CLI)).toBe(true));

  test("initialize + tools/list: stdout is JSON-RPC only with the five tools; the banner is on stderr", () => {
    const r = run({ HOROS_BASE_URL: "http://127.0.0.1:1" });
    const lines = r.out.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(2);
    const msgs = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id: number; result: { tools?: { name: string }[] } });
    for (const m of msgs) expect(m.jsonrpc).toBe("2.0");
    const list = msgs.find((m) => m.id === 1);
    expect(list?.result.tools?.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(r.err).toMatch(/^horos-mcp: advisory \(no Payment key\).*api http:\/\/127\.0\.0\.1:1, chain 5042002\n$/);
  });

  test("a malformed Payment key exits non-zero, naming the variable only", () => {
    const r = run({ HOROS_BASE_URL: "http://127.0.0.1:1", HOROS_POLICY_WALLET: "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c", HOROS_PAYMENT_PRIVATE_KEY: "0x12" });
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/HOROS_PAYMENT_PRIVATE_KEY/);
    expect(r.err).not.toContain("0x12");
  });
});
