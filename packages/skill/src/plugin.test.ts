// The Claude Code plugin: manifest shapes, the repo-root marketplace entry, and SKILL.md content rules.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(pkgRoot, "../..");
const pluginRoot = join(pkgRoot, "plugin");
const skillPath = join(pluginRoot, "skills/horos-quickstart/SKILL.md");
const skill = readFileSync(skillPath, "utf8");

test("plugin.json: name, version, description; no other components declared", () => {
  const p = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
  expect(p.name).toBe("horos");
  expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(typeof p.description).toBe("string");
  expect(p.mcpServers).toBeUndefined();
  expect(p.hooks).toBeUndefined();
});

test("marketplace.json at the repo root lists the plugin at ./packages/skill/plugin", () => {
  const m = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin/marketplace.json"), "utf8")) as {
    name: string;
    owner: { name: string };
    plugins: { name: string; source: string }[];
  };
  expect(m.name).toBe("horos");
  expect(typeof m.owner.name).toBe("string");
  expect(m.plugins).toEqual([expect.objectContaining({ name: "horos", source: "./packages/skill/plugin" })]);
  expect(existsSync(join(repoRoot, m.plugins[0]?.source ?? "", ".claude-plugin/plugin.json"))).toBe(true);
});

test("package.json ships the plugin directory", () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { files: string[]; bin: Record<string, string> };
  expect(pkg.files).toContain("plugin");
  expect(pkg.bin).toEqual({ "horos-quickstart": "./dist/cli.js" });
});

test("plugin.json version matches package.json", () => {
  const p = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")) as { version: string };
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string };
  expect(p.version).toBe(pkg.version);
});

test("SKILL.md: local-checkout invocation first; npm only after publication; no npx --yes", () => {
  expect(skill.indexOf("node <horos-checkout>/packages/skill/dist/cli.js")).toBeLessThan(skill.indexOf("npx --package @horos/skill"));
  expect(skill).toMatch(/After publication, `npx --package @horos\/skill/);
  expect(skill).not.toMatch(/npx --yes/);
  expect(skill).toMatch(/file:<horos-checkout>\/packages\/sdk/);
});

test("SKILL.md frontmatter: name and description", () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
  expect(fm).toMatch(/^name: horos-quickstart$/m);
  expect(fm).toMatch(/^description: .{40,}$/m);
});

test("SKILL.md: the steps appear in order", () => {
  const order = [
    "horos-quickstart start",
    "horos-quickstart preflight",
    "Choose enforced or Shadow",
    "Install the SDK",
    "horos-quickstart deploy --human <address>",
    "horos-quickstart smoke\n",
    "horos-quickstart shadow\n",
    "horos-quickstart smoke --shadow",
    "Report the elapsed time",
  ];
  let at = -1;
  for (const s of order) {
    const i = skill.indexOf(s, at + 1);
    expect(i, s).toBeGreaterThan(at);
    at = i;
  }
});

test("SKILL.md carries the key rules", () => {
  expect(skill).toMatch(/HOROS_PAYMENT_PRIVATE_KEY/);
  expect(skill).toMatch(/never write a key or an API key into any file/i);
  expect(skill).toMatch(/Never ask for, read or accept the Human \(Policy Owner\) private key/);
  expect(skill).toMatch(/Ask only for the Human's \*\*address\*\*/);
  expect(skill).toMatch(/Never install `@horos\/owner`/);
  expect(skill).toMatch(/`\.env\*` must be gitignored/);
  expect(skill).toMatch(/show(?:ing)? the developer the (?:full )?diff/i);
});

test("SKILL.md shows the insertion pattern: check, stop unless allow/cap, pay min(amount, payable) after getRecord; Shadow logs only", () => {
  expect(skill).toContain("await horos.check({ counterparty, amount })");
  expect(skill).toMatch(/res\.decision !== "allow" && res\.decision !== "cap"/);
  expect(skill).toContain("payable_amount");
  expect(skill).toContain("horos.getRecord(res.record_id)");
  expect(skill).toMatch(/functionName: "pay",\n\s+args: \[counterparty, payAmount, recordHash\]/);
  expect(skill).toContain("apiKey: process.env.HOROS_API_KEY");
  expect(skill).toMatch(/the existing transfer, unchanged/);
  expect(skill).toContain("circleDcwSigner");
  expect(skill).toMatch(/Node >= 20\.12/);
  expect(skill).toMatch(/uses `viem`/);
  expect(skill).toContain('functionName: "remaining"');
  expect(skill).toContain("waitForTransactionReceipt");
  expect(skill).toMatch(/PolicyWallet must hold USDC before live use/);
});

test("SKILL.md: the Shadow key stays in its file and out of the chat; smoke side effects are stated", () => {
  expect(skill).toContain("~/.config/horos/shadow-api-key");
  expect(skill).toMatch(/Never read, `cat` or print the key file yourself/);
  expect(skill).toMatch(/never to paste the key into the chat/);
  expect(skill).toMatch(/one first-contact Limit write/);
  expect(skill).toMatch(/`pay` step is a simulation only/);
});

test("SKILL.md never instructs installing @horos/owner and makes no compliance claims", () => {
  expect(skill).not.toMatch(/(?:npm|pnpm|yarn|bun|npx)\b[^\n`]*\b(?:i|install|add)\b[^\n`]*@horos\/owner/i);
  expect(skill).not.toMatch(/"@horos\/owner"\s*:/);
  expect(skill).not.toMatch(/makes? (?:you|your \w+|anyone) compliant(?! )/i);
  expect(skill).not.toMatch(/(?:ensures?|guarantees?|achieves?) (?:\w+ )?compliance/i);
  expect(skill).not.toMatch(/\bOFAC[- ]compliant\b/i);
});
