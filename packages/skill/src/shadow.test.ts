import { existsSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HorosError, type ShadowSignupOptions } from "@horos/sdk";
import { afterAll, expect, test, vi } from "vitest";
import { main, type CliDeps } from "./cli.js";
import { CONFIG_FILE } from "./config.js";
import { API_KEY, BASE_URL, CUSTOMER, ENV, io, KEY_ADDRESS, readJson, scanAndCleanTempRepos, SHADOW_SCOPE, tempHome, tempRepo } from "./harness.test-helpers.js";

afterAll(scanAndCleanTempRepos);

function setup(env: Record<string, string> = ENV, fake = vi.fn(async (o: ShadowSignupOptions) => (void o, { customerId: CUSTOMER, scope: SHADOW_SCOPE, apiKey: API_KEY }))) {
  const root = tempRepo();
  const home = tempHome();
  const x = io();
  const deps: CliDeps = { root, env, out: x.o, err: x.e, now: () => 0, nodeVersion: "24.1.0", home, shadow: { shadowSignup: fake } };
  return { root, home, x, deps, fake };
}

test("shadow: key written to a 0600 file outside the repo, never printed; config has mode shadow + scope", async () => {
  const { root, home, x, deps, fake } = setup();
  expect(await main(["shadow"], deps)).toBe(0);
  expect(fake.mock.calls[0]?.[0].signer.address.toLowerCase()).toBe(KEY_ADDRESS);
  expect(fake.mock.calls[0]?.[0].baseUrl).toBe(BASE_URL);
  const keyPath = join(home, ".config/horos/shadow-api-key");
  expect(readFileSync(keyPath, "utf8")).toBe(`${API_KEY}\n`);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  expect(x.all()).not.toContain(API_KEY);
  expect(x.out.join("\n")).toContain(`export HOROS_API_KEY="$(cat '${keyPath}')"`);
  expect(readJson(root, CONFIG_FILE)).toEqual({ baseUrl: BASE_URL, chainId: 5042002, policyWallet: null, scope: SHADOW_SCOPE, customerId: CUSTOMER, mode: "shadow" });
});

test("--key-file: honoured outside the repo; refused inside it (also via a symlink), before any sign-up", async () => {
  const { home, deps } = setup();
  const custom = join(home, "keys", "horos.key");
  expect(await main(["shadow", "--key-file", custom], deps)).toBe(0);
  expect(statSync(custom).mode & 0o777).toBe(0o600);

  const s2 = setup();
  expect(await main(["shadow", "--key-file", "secrets/key"], s2.deps)).toBe(1);
  expect(s2.fake).not.toHaveBeenCalled();
  expect(s2.x.all()).toMatch(/inside the agent repo/);

  const s3 = setup();
  symlinkSync(s3.root, join(s3.home, "repo-link"));
  expect(await main(["shadow", "--key-file", join(s3.home, "repo-link", "k")], s3.deps)).toBe(1);
  expect(s3.fake).not.toHaveBeenCalled();
  expect(existsSync(join(s3.root, "k"))).toBe(false);
});

test("shadow_closed: tells the developer to use enforced mode; nothing written", async () => {
  const closed = vi.fn(async () => {
    throw new HorosError({ code: "shadow_closed", message: "closed", retryable: false, status: 410, attempts: 1 });
  });
  const { root, x, deps } = setup(ENV, closed);
  expect(await main(["shadow"], deps)).toBe(1);
  expect(x.all()).toMatch(/Use the enforced path/);
  expect(existsSync(join(root, CONFIG_FILE))).toBe(false);
});

test("shadow without a Payment key: nothing runs", async () => {
  const { x, deps, fake } = setup({ HOROS_BASE_URL: BASE_URL });
  expect(await main(["shadow"], deps)).toBe(1);
  expect(fake).not.toHaveBeenCalled();
  expect(x.all()).toMatch(/HOROS_PAYMENT_PRIVATE_KEY is not set/);
});

test("an API key the api echoes into a public field is never written to the repo", async () => {
  const echo = vi.fn(async () => ({ customerId: API_KEY, scope: SHADOW_SCOPE, apiKey: API_KEY }));
  const { root, x, deps } = setup(ENV, echo);
  expect(await main(["shadow"], deps)).toBe(1);
  expect(x.all()).toMatch(/refused to write horos\.config\.json/);
  expect(x.all()).not.toContain(API_KEY);
  expect(existsSync(join(root, CONFIG_FILE))).toBe(false);
});
