import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HorosError, type DeployPolicyWalletOptions } from "@horos/sdk";
import { afterAll, expect, test, vi } from "vitest";
import { main, type CliDeps } from "./cli.js";
import { CONFIG_FILE } from "./config.js";
import { BASE_URL, CUSTOMER, deployResult, ENFORCED_SCOPE, ENV, HUMAN, io, KEY, KEY_ADDRESS, readJson, scanAndCleanTempRepos, tempRepo, WALLET, tempHome } from "./harness.test-helpers.js";
import { QUICKSTART_FILE } from "./timing.js";

afterAll(scanAndCleanTempRepos);

function setup(env: Record<string, string> = ENV, fake = vi.fn(async (o: DeployPolicyWalletOptions) => (o.log?.("DEPLOY REPORT"), deployResult()))) {
  const root = tempRepo();
  const x = io();
  const deps: CliDeps = {
    root,
    env,
    out: x.o,
    err: x.e,
    now: () => Date.parse("2026-09-30T00:00:00Z"),
    nodeVersion: "24.1.0", home: tempHome(),
    deploy: { deployPolicyWallet: fake, clients: () => ({ publicClient: {} as never, walletClient: { chain: { id: 5042002 } } as never }) },
  };
  return { root, x, deps, fake };
}

test("deploy: Human address + env key → SDK deploy helper, horos.config.json with public values only, report printed", async () => {
  const { root, x, deps, fake } = setup();
  expect(await main(["deploy", "--human", HUMAN], deps)).toBe(0);
  expect(fake).toHaveBeenCalledOnce();
  const o = fake.mock.calls[0]?.[0];
  expect(o?.humanAddress).toBe(HUMAN);
  expect(o?.baseUrl).toBe(BASE_URL);
  expect(o?.chainId).toBe(5042002);
  expect(o?.payment.kind).toBe("eoa");
  expect(o?.payment.kind === "eoa" ? o.payment.account.address.toLowerCase() : "").toBe(KEY_ADDRESS);
  expect(readJson(root, CONFIG_FILE)).toEqual({ baseUrl: BASE_URL, chainId: 5042002, policyWallet: WALLET, scope: ENFORCED_SCOPE, customerId: CUSTOMER, mode: "enforced" });
  expect(x.out.join("\n")).toMatch(/DEPLOY REPORT/);
  expect((readJson(root, QUICKSTART_FILE).steps as { step: string }[]).map((s) => s.step)).toEqual(["deploy"]);
  expect(x.all()).not.toContain(KEY.slice(2));
});

test("--human given as a key: nothing runs, custody explained, value never echoed", async () => {
  for (const argv of [["deploy", "--human", KEY], ["deploy", `--human=${KEY.slice(2)}`]]) {
    const { root, x, deps, fake } = setup();
    expect(await main(argv, deps)).toBe(1);
    expect(fake).not.toHaveBeenCalled();
    expect(x.all()).toMatch(/custody/);
    expect(x.all().toLowerCase()).not.toContain(KEY.slice(2));
    expect(existsSync(join(root, CONFIG_FILE))).toBe(false);
  }
});

test("no Payment key: nothing runs; explains the env variable and the Circle path", async () => {
  const { root, x, deps, fake } = setup({ HOROS_BASE_URL: BASE_URL });
  expect(await main(["deploy", "--human", HUMAN], deps)).toBe(1);
  expect(fake).not.toHaveBeenCalled();
  expect(x.all()).toMatch(/HOROS_PAYMENT_PRIVATE_KEY is not set/);
  expect(x.all()).toMatch(/circleDcwSigner/);
  expect(existsSync(join(root, CONFIG_FILE))).toBe(false);
});

test("@horos/owner present: deploy refuses", async () => {
  const { x, deps, fake } = setup();
  const root = tempRepo({ pkg: { name: "agent", devDependencies: { "@horos/owner": "1" } } });
  expect(await main(["deploy", "--human", HUMAN], { ...deps, root })).toBe(1);
  expect(fake).not.toHaveBeenCalled();
  expect(x.all()).toMatch(/Human tooling must stay out of the agent repo/);
});

test("SDK errors are surfaced with their code; no config written", async () => {
  const fail = vi.fn(async () => {
    throw new HorosError({ code: "validation_failed", message: "refused: the Human address equals the Payment address", retryable: false, attempts: 0 });
  });
  const { root, x, deps } = setup(ENV, fail);
  expect(await main(["deploy", "--human", HUMAN], deps)).toBe(1);
  expect(x.all()).toMatch(/horos-quickstart deploy: validation_failed: refused: the Human address equals the Payment address/);
  expect(existsSync(join(root, CONFIG_FILE))).toBe(false);
});

test("unexpected errors print only their name", async () => {
  const fail = vi.fn(async () => {
    throw new TypeError(`boom ${KEY}`);
  });
  const { x, deps } = setup(ENV, fail);
  expect(await main(["deploy", "--human", HUMAN], deps)).toBe(1);
  expect(x.all()).toMatch(/deploy: TypeError$/);
});

test("deploy refuses when horos.config.json already names an enforced PolicyWallet, unless --force", async () => {
  const { root, x, deps, fake } = setup();
  expect(await main(["deploy", "--human", HUMAN], deps)).toBe(0);
  expect(await main(["deploy", "--human", HUMAN], deps)).toBe(1);
  expect(fake).toHaveBeenCalledOnce();
  expect(x.all()).toMatch(/would deploy a SECOND wallet/);
  expect(await main(["deploy", "--human", HUMAN, "--force"], deps)).toBe(0);
  expect(fake).toHaveBeenCalledTimes(2);
  expect(readJson(root, CONFIG_FILE).policyWallet).toBe(WALLET);
});

test("a timer-file failure after a successful deploy warns and exits 0", async () => {
  const { root, x, deps, fake } = setup();
  mkdirSync(join(root, QUICKSTART_FILE), { recursive: true }); // a directory where the file should be: the write fails
  expect(await main(["deploy", "--human", HUMAN], deps)).toBe(0);
  expect(fake).toHaveBeenCalledOnce();
  expect(x.err.join("\n")).toMatch(/warning: deploy succeeded, but \.horos\/quickstart\.json could not be updated.*Do not rerun deploy/);
  expect(readJson(root, CONFIG_FILE).policyWallet).toBe(WALLET);
});
