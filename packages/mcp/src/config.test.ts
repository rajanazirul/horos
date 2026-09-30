import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, test } from "vitest";
import { ConfigError, configFromEnv, DEFAULT_CHAIN_ID } from "./config.js";
import { main } from "./cli.js";

// Well-known Foundry/Anvil dev key. Test-only; never funded on any real network.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WALLET = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00";
const BASE = { HOROS_BASE_URL: "https://api.horos.test" };

function configError(env: Record<string, string>): ConfigError {
  try {
    configFromEnv(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

test("minimal env: advisory, default chain id, no signer", () => {
  const c = configFromEnv(BASE);
  expect(c.options).toEqual({ baseUrl: "https://api.horos.test", chainId: DEFAULT_CHAIN_ID });
  expect(c.signerAddress).toBeUndefined();
  expect(c.options.signer).toBeUndefined();
});

test("full env: signer from the Payment key, wallet, scope and chain id", () => {
  const c = configFromEnv({ ...BASE, HOROS_CHAIN_ID: "31337", HOROS_POLICY_WALLET: WALLET, HOROS_SCOPE: SCOPE, HOROS_PAYMENT_PRIVATE_KEY: KEY });
  expect(c.options).toMatchObject({ chainId: 31337, policyWallet: WALLET, scope: SCOPE });
  expect(c.signerAddress).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  expect(c.options.signer?.address.toLowerCase()).toBe(c.signerAddress);
});

test("empty values count as unset", () => {
  expect(configFromEnv({ ...BASE, HOROS_PAYMENT_PRIVATE_KEY: "", HOROS_SCOPE: " " }).options).toEqual({ baseUrl: "https://api.horos.test", chainId: DEFAULT_CHAIN_ID });
});

test.each([
  ["HOROS_BASE_URL", {}],
  ["HOROS_BASE_URL", { HOROS_BASE_URL: "api.horos.test" }],
  ["HOROS_BASE_URL", { HOROS_BASE_URL: "ftp://api.horos.test" }],
  ["HOROS_CHAIN_ID", { ...BASE, HOROS_CHAIN_ID: "0" }],
  ["HOROS_CHAIN_ID", { ...BASE, HOROS_CHAIN_ID: "5042002x" }],
  ["HOROS_POLICY_WALLET", { ...BASE, HOROS_POLICY_WALLET: "0x12" }],
  ["HOROS_SCOPE", { ...BASE, HOROS_SCOPE: "enforced:nope" }],
  ["HOROS_PAYMENT_PRIVATE_KEY", { ...BASE, HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: "0x12" }],
  ["HOROS_PAYMENT_PRIVATE_KEY", { ...BASE, HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: `0x${"0".repeat(64)}` }],
  ["HOROS_PAYMENT_PRIVATE_KEY", { ...BASE, HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: `0x${"f".repeat(64)}` }],
  ["HOROS_POLICY_WALLET", { ...BASE, HOROS_PAYMENT_PRIVATE_KEY: KEY }],
  ["HOROS_BASE_URL", { HOROS_BASE_URL: "http://api.horos.test", HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: KEY }],
  ["HOROS_BASE_URL", { HOROS_BASE_URL: "http://10.0.0.5:8080", HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: KEY }],
])("%s is named in the error, and no value is echoed", (variable, env: Record<string, string>) => {
  const err = configError(env);
  expect(err.variable).toBe(variable);
  expect(err.message.startsWith(variable)).toBe(true);
  for (const v of Object.values(env)) if (v.length > 3) expect(err.message).not.toContain(v);
  expect(err.message).not.toContain(KEY.slice(2));
  expect(err.message).not.toContain("0".repeat(64));
  expect(err.message).not.toContain("f".repeat(64));
});

test("cli: a bad key exits non-zero, names the variable only, and never touches stdout", async () => {
  const errs: string[] = [];
  let connected = false;
  const code = await main(
    { ...BASE, HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: "0x12" },
    {
      err: (s) => errs.push(s),
      transport: () => {
        connected = true;
        throw new Error("must not connect");
      },
    },
  );
  expect(code).not.toBe(0);
  expect(connected).toBe(false);
  expect(errs.join("\n")).toMatch(/^horos-mcp: HOROS_PAYMENT_PRIVATE_KEY /);
  expect(errs.join("\n")).not.toContain("0x12");
});

test("with a Payment key, plain http is accepted only for loopback hosts", () => {
  for (const base of ["http://localhost:3000", "http://127.0.0.1:1", "http://[::1]:8080", "https://api.horos.test"]) {
    expect(configFromEnv({ HOROS_BASE_URL: base, HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: KEY }).signerAddress).toBeDefined();
  }
  // Without a key nothing is signed, so plain http to a remote host stays allowed.
  expect(configFromEnv({ HOROS_BASE_URL: "http://api.horos.test" }).signerAddress).toBeUndefined();
});

function fakeTransport(fail = false): Transport & { started: boolean } {
  const t = {
    started: false,
    async start() {
      if (fail) throw new TypeError("stdin closed: secret-ish detail");
      t.started = true;
    },
    async send() {},
    async close() {},
  };
  return t;
}

test("cli: advisory banner names the target and no key", async () => {
  const errs: string[] = [];
  const t = fakeTransport();
  const code = await main({ HOROS_BASE_URL: "https://api.horos.test/base/", HOROS_SCOPE: SCOPE }, { err: (s) => errs.push(s), transport: () => t });
  expect(code).toBe(0);
  expect(t.started).toBe(true);
  expect(errs).toEqual(["horos-mcp: advisory (no Payment key): Checks write nothing and are not enforcement; api https://api.horos.test, chain 5042002"]);
});

test("cli: enforced banner names the signer, target and PolicyWallet, never the key", async () => {
  const errs: string[] = [];
  const code = await main(
    { ...BASE, HOROS_CHAIN_ID: "31337", HOROS_POLICY_WALLET: WALLET, HOROS_PAYMENT_PRIVATE_KEY: KEY },
    { err: (s) => errs.push(s), transport: () => fakeTransport() },
  );
  expect(code).toBe(0);
  expect(errs).toEqual([
    `horos-mcp: enforced (signed by 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266); api https://api.horos.test, chain 31337, PolicyWallet ${WALLET}`,
  ]);
  expect(errs.join("")).not.toContain(KEY.slice(2));
});

test("cli: a transport that fails to start exits 1 with only the error name", async () => {
  const errs: string[] = [];
  const code = await main(BASE, { err: (s) => errs.push(s), transport: () => fakeTransport(true) });
  expect(code).toBe(1);
  expect(errs).toEqual(["horos-mcp: failed to start (TypeError)"]);
});
