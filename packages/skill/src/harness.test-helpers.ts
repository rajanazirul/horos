// Shared test fakes: temp agent repos, a well-known test key, fake SDK clients, and the secret scan every test file
// runs over the files the CLI wrote.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult, DeployResult } from "@horos/sdk";
import { expect } from "vitest";

// Well-known Foundry/Anvil dev key #0. Test-only; never funded on any real network.
export const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const KEY_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
export const API_KEY = "hsk_TESTONLY-abcdefghijklmnopqrstuvwxyz0123456789";
export const HUMAN = "0x3b60ebece31658efda2ad1cd28860cabbf2e4e85";
export const WALLET = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
export const CUSTOMER = "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00";
export const ENFORCED_SCOPE = `enforced:${CUSTOMER}`;
export const SHADOW_SCOPE = `shadow:${CUSTOMER}`;
export const BASE_URL = "https://api.horos.test";
export const DEMO = "0x398edfeb6a0574f16f35f9b5353e5b398442acd9";
export const GOOD = "0x1111111111111111111111111111111111111111";
export const RECORD_ID = "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f01";
export const ENV = { HOROS_BASE_URL: BASE_URL, HOROS_PAYMENT_PRIVATE_KEY: KEY };

const roots: string[] = [];
const others: string[] = [];

/** A temp directory outside any repo (a fake home). Cleaned up, but not secret-scanned: the Shadow key file lives here. */
export function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "horos-home-"));
  others.push(d);
  return d;
}

/** A temp agent repo with a package.json and a .gitignore that ignores .env*. */
export function tempRepo(opts: { pkg?: Record<string, unknown>; gitignore?: string | null } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "horos-qs-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(opts.pkg ?? { name: "agent", version: "1.0.0", dependencies: { viem: "2.56.9" } }));
  if (opts.gitignore !== null) writeFileSync(join(root, ".gitignore"), opts.gitignore ?? "node_modules/\n.env*\n!.env.example\n");
  return root;
}

function files(dir: string): string[] {
  return readdirSync(dir).filter((n) => n !== ".git").flatMap((n) => {
    const p = join(dir, n);
    return lstatSync(p).isSymbolicLink() ? [] : statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** No file in any temp repo holds a private key or an API key. Then clean up. */
export function scanAndCleanTempRepos(): void {
  const checked: string[] = [];
  for (const root of roots.splice(0)) {
    for (const f of files(root)) {
      // Test-authored .env files hold the test key on purpose; everything else was written by the CLI.
      if (!statSync(f).isFile() || /^\.env/.test(f.split("/").pop() ?? "")) continue;
      const text = readFileSync(f, "utf8");
      checked.push(f);
      expect(text.toLowerCase(), f).not.toContain(KEY.slice(2).toLowerCase());
      expect(text, f).not.toContain("hsk_");
      expect(text, f).not.toMatch(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/);
    }
    rmSync(root, { recursive: true, force: true });
  }
  for (const d of others.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function readJson(root: string, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
}

export function checkResult(over: Partial<CheckResult> & Pick<CheckResult, "decision">): CheckResult {
  return {
    effective_limit: "100000000",
    remaining: "100000000",
    reason: "test reason",
    confidence: 1,
    record_id: RECORD_ID,
    simulated: false,
    advisory: false,
    limit_write: "pending",
    chain_state: "live",
    ...over,
  } as CheckResult;
}

export function deployResult(): DeployResult {
  return {
    policyWallet: WALLET,
    scope: ENFORCED_SCOPE,
    customerId: CUSTOMER,
    codehash: `0x${"ab".repeat(32)}`,
    roles: { human: HUMAN, payment: KEY_ADDRESS, registrar: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc", model: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7", rules: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
    policy: { firstContactCeiling: 500_000_000n, walletPeriodCap: 5_000_000_000n, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n },
    chainId: 5042002,
  } as DeployResult;
}

/** Capture stdout/stderr lines. */
export function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, o: (s: string) => out.push(s), e: (s: string) => err.push(s), all: () => [...out, ...err].join("\n") };
}
