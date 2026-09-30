// AD-12/AD-22: @horos/skill depends only on the SDK, the schema and viem. No Circle SDK, no @horos/owner.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

test("package.json declares only the allowed dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
  expect(Object.keys(deps).sort()).toEqual(["@horos/schema", "@horos/sdk", "viem"]);
  expect(pkg.dependencies?.viem).toBe("2.56.9");
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.[cm]?[jt]sx?$/.test(name) && !/\.test(?:-helpers)?\.[cm]?[jt]sx?$/.test(name) ? [p] : [];
  });
}

/** Every module specifier (static, type-only, re-export, dynamic, require), via the TypeScript pre-processor. */
function specifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

test("sources import only node builtins, @horos/sdk, @horos/schema and viem; viem only in env.ts, chain.ts and (types) deploy.ts", () => {
  const files = sources(join(root, "src"));
  expect(files.length).toBeGreaterThanOrEqual(8);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const spec of specifiers(text)) {
      expect(spec, `${f}: ${spec}`).toMatch(/^(?:\.\.?\/|node:|@horos\/(?:sdk|schema)$|viem$|viem\/(?:accounts|chains)$)/);
      if (spec.startsWith("viem")) expect(/(?:env|chain|deploy)\.ts$/.test(f), f).toBe(true);
    }
    expect(text, f).not.toMatch(/circle-fin|drizzle|postgres/i);
  }
});
