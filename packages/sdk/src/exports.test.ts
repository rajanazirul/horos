// AD-12: the SDK never signs or builds a Human-domain payload. Checks the public export names and every SDK source
// file (src and examples, tests excluded: this file names the forbidden symbols to look for them).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as sdk from "./index.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.[cm]?[jt]s$/.test(e.name) && !/\.test\.[cm]?[jt]s$/.test(e.name) ? [p] : [];
  });
}

test("the public exports are the curated list, none of them Human-related", () => {
  expect(Object.keys(sdk).sort()).toEqual(["DEFAULT_CHECK_EXPIRY_SECONDS", "HorosError", "STANDARD_PRESET", "circleDcwSigner", "createHoros", "deployPolicyWallet", "formatDeployReport", "fromViemAccount", "shadowSignup"]);
  for (const name of Object.keys(sdk)) expect(name).not.toMatch(/human/i);
});

test("no SDK source file references Human-domain symbols or @horos/owner", () => {
  const files = [...sources(join(root, "src")), ...sources(join(root, "examples"))];
  expect(files.length).toBeGreaterThan(3);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    expect(text, f).not.toMatch(/HUMAN_|humanDomain|@horos\/owner|Horos Human/);
  }
});

test("the index has no `export *` (named exports only)", () => {
  expect(readFileSync(join(root, "src", "index.ts"), "utf8")).not.toMatch(/export\s*\*/);
});
