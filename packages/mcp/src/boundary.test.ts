// AD-12/AD-17: @horos/mcp is a thin layer over the SDK. It depends on no owner, adapters, pipeline or database
// package, and its sources import only the SDK, the schema, the MCP SDK, zod, viem (Payment-key account) and node builtins.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

test("package.json declares only the allowed dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
  expect(Object.keys(deps).sort()).toEqual(["@horos/schema", "@horos/sdk", "@modelcontextprotocol/sdk", "viem", "zod"]);
  expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toBe("1.30.1");
});

/** Every non-test source file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.[cm]?[jt]sx?$/.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name) ? [p] : [];
  });
}

/**
 * Module specifiers in every form: `import … from`, `export … from`, side-effect `import "x"`, dynamic `import("x")`
 * and `require("x")`, with single, double or backtick quotes.
 */
export function specifiers(source: string): string[] {
  // Comments first: prose such as "comes from `x`" is not an import.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/g;
  return [...text.matchAll(re)].map((m) => m[2] ?? "");
}

test("the specifier scan sees every import form", () => {
  const sample = [
    `import a from 'single';`,
    `import "side-effect";`,
    `const m = await import("dynamic");`,
    "const r = require(`required`);",
    `export { x } from "re-export";`,
    `export * from './star.js';`,
    `import type { T } from "typed";`,
    `// a comment that comes from "nowhere"`,
    `/** also from \`nowhere\` */`,
  ].join("\n");
  expect(specifiers(sample)).toEqual(["single", "side-effect", "dynamic", "required", "re-export", "./star.js", "typed"]);
});

test("sources import only the allowed modules; viem only for the Payment-key account", () => {
  const files = sources(join(root, "src"));
  expect(files.length).toBeGreaterThanOrEqual(4);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const spec of specifiers(text)) {
      expect(spec, `${f}: ${spec}`).toMatch(/^(?:\.\.?\/|node:|@horos\/(?:sdk|schema)$|@modelcontextprotocol\/sdk\/|zod$|viem\/accounts$)/);
      if (spec.startsWith("viem")) expect(f.endsWith("config.ts"), f).toBe(true);
    }
    expect(text, f).not.toMatch(/@horos\/(?:owner|adapters|pipeline)|drizzle|postgres|circle-fin/i);
  }
});
