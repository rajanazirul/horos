import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { withDotEnv } from "./env.js";
import { main, parseArgs, USAGE } from "./cli.js";
import { io, KEY, scanAndCleanTempRepos, tempRepo, tempHome } from "./harness.test-helpers.js";
import { QUICKSTART_FILE, readQuickstart } from "./timing.js";

afterAll(scanAndCleanTempRepos);

const deps = (root: string, x: ReturnType<typeof io>) => ({ root, env: {}, out: x.o, err: x.e, now: () => Date.parse("2026-09-30T10:00:00Z"), nodeVersion: "24.1.0", home: tempHome() });

test("args: value flags in both forms, unknown flags refused without echo", () => {
  expect(parseArgs(["deploy", "--human", "0xabc"]).flags.get("--human")).toBe("0xabc");
  expect(parseArgs(["deploy", "--human=0xabc"]).flags.get("--human")).toBe("0xabc");
  expect(() => parseArgs(["deploy", `--key=${KEY}`])).toThrow(/unknown option --key$/);
  expect(() => parseArgs(["deploy", "--human"])).toThrow(/needs a value/);
});

test("usage, unknown commands and misplaced flags", async () => {
  const x = io();
  const root = tempRepo();
  expect(await main([], deps(root, x))).toBe(2);
  expect(await main(["--help"], deps(root, x))).toBe(0);
  expect(x.out).toContain(USAGE);
  expect(await main(["frobnicate"], deps(root, x))).toBe(2);
  expect(await main(["preflight", "--human", "0x1"], deps(root, x))).toBe(2);
  expect(await main(["deploy", "extra", "args"], deps(root, x))).toBe(2);
});

test("start writes the timer file and refuses with @horos/owner present", async () => {
  const x = io();
  const root = tempRepo();
  expect(await main(["start"], deps(root, x))).toBe(0);
  const q = readQuickstart(root);
  expect(q.startedAt).toBe("2026-09-30T10:00:00.000Z");
  expect(q.elapsedSeconds).toBeNull();
  expect(x.out.join("\n")).toContain(QUICKSTART_FILE);
  const owned = tempRepo({ pkg: { name: "a", dependencies: { "@horos/owner": "1" } } });
  expect(await main(["start"], deps(owned, x))).toBe(1);
});

test("args: a key pasted as a flag name is never echoed; a following flag is not a value", () => {
  for (const a of [`--${KEY}`, `-${KEY.slice(2)}`, `--${KEY.slice(2)}=x`, "--ac09deadbeef", `--${"a".repeat(40)}`]) {
    let msg = "";
    try {
      parseArgs(["deploy", a]);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toBe("unknown option (value not printed)");
  }
  expect(() => parseArgs(["deploy", "--bogus"])).toThrow(/unknown option --bogus$/);
  expect(() => parseArgs(["smoke", "--human", "--shadow"])).toThrow(/--human needs a value/);
  expect(() => parseArgs(["smoke", "--good", "-1"])).toThrow(/--good needs a value/);
});

test("<root>/.env is loaded without overriding variables already set", async () => {
  const root = tempRepo();
  writeFileSync(join(root, ".env"), `HOROS_PAYMENT_PRIVATE_KEY=${KEY}\nHOROS_BASE_URL=https://from-dotenv.test\n`);
  const x = io();
  expect(await main(["preflight"], { ...deps(root, x), env: { HOROS_BASE_URL: "https://from-shell.test" } })).toBe(0);
  expect(x.all()).toMatch(/HOROS_PAYMENT_PRIVATE_KEY is set \(value not shown\)/);
  expect(x.all()).not.toContain(KEY.slice(2));
  expect(withDotEnv(root, { HOROS_BASE_URL: "https://from-shell.test" }).HOROS_BASE_URL).toBe("https://from-shell.test");
  expect(withDotEnv(root, {}).HOROS_BASE_URL).toBe("https://from-dotenv.test");
});
