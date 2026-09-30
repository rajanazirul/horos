// Anvil integration (Story 3.2): the existing-EOA path of deployPolicyWallet against a local Osaka chain, with a fake
// api. Proves the committed creation bytecode deploys to the pinned runtime codehash and that the roles read back.
// Gated on HOROS_TEST_ANVIL=1 (needs `anvil` on PATH).
import { spawn, type ChildProcess } from "node:child_process";
import { errorEnvelope, type Hex, type OnboardingResponse } from "@horos/schema";
import { createPublicClient, createWalletClient, http, keccak256, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deployPolicyWallet } from "./deploy.js";
import { expectedRuntimeCodehash } from "./generated/policy-wallet-artifact.js";
import type { FetchLike } from "./internal.js";

// Anvil's default dev mnemonic (never funded on any real network).
const MNEMONIC = "test test test test test test test test test test test junk";
const keyAt = (i: number): Hex => {
  const pk = mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey;
  if (pk === null) throw new Error("no key");
  return toHex(pk);
};
const lower = (a: string) => a.toLowerCase() as Hex;
const owner = lower(privateKeyToAccount(keyAt(0)).address);
const payment = privateKeyToAccount(keyAt(1));
const registrar = lower(privateKeyToAccount(keyAt(2)).address);
const model = lower(privateKeyToAccount(keyAt(3)).address);
const rules = lower(privateKeyToAccount(keyAt(4)).address);
const SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00";
const CUSTOMER = "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f10";

describe.skipIf(process.env["HOROS_TEST_ANVIL"] !== "1")("deployPolicyWallet on anvil (existing EOA)", () => {
  let anvil: ChildProcess | undefined;
  let url: string;
  const chain = (u: string) => ({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [u] } } }) as const;

  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    anvil = spawn("anvil", ["--port", String(port), "--hardfork", "osaka", "--silent"], { stdio: "ignore" });
    url = `http://127.0.0.1:${port}`;
    const pub = createPublicClient({ chain: chain(url), transport: http(url) });
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("anvil did not start");
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  test("deploys from the Payment EOA; codehash equals the pinned build; roles read back; binds", async () => {
    const publicClient = createPublicClient({ chain: chain(url), transport: http(url) });
    const walletClient = createWalletClient({ account: payment, chain: chain(url), transport: http(url) });
    const provisioned: OnboardingResponse = { customerId: CUSTOMER, scope: SCOPE, status: "provisioned", registrar, model, rules };
    let boundWallet: Hex | undefined;
    const requests: string[] = [];
    const fetch: FetchLike = async (u, init) => {
      requests.push(u);
      const body = JSON.parse(init.body ?? "{}") as { policy_wallet?: string };
      if (u.endsWith("/v1/onboarding")) return Response.json(provisioned);
      if (u.endsWith("/v1/onboarding/bind")) {
        if (body.policy_wallet === undefined) return Response.json(errorEnvelope("validation_failed", "no wallet"), { status: 400 });
        boundWallet = lower(body.policy_wallet);
        return Response.json({ ...provisioned, status: "bound", policyWallet: boundWallet });
      }
      return Response.json(errorEnvelope("not_found", "no route"), { status: 404 });
    };
    const logs: string[] = [];

    const result = await deployPolicyWallet({
      baseUrl: "http://api.horos.test",
      chainId: 31337,
      humanAddress: owner,
      payment: { kind: "eoa", account: payment, walletClient },
      publicClient,
      fetch,
      log: (l) => logs.push(l),
      pollIntervalMs: 50,
    });

    expect(requests.map((u) => new URL(u).pathname)).toEqual(["/v1/onboarding", "/v1/onboarding/bind"]);
    expect(result.policyWallet).toBe(boundWallet);
    const code = await publicClient.getCode({ address: result.policyWallet });
    expect(code === undefined ? undefined : keccak256(code)).toBe(expectedRuntimeCodehash);
    expect(result.codehash).toBe(expectedRuntimeCodehash);
    expect(result.roles).toEqual({ human: owner, payment: lower(payment.address), registrar, model, rules });
    expect(logs.join("\n")).toMatch(/Funding/);
  }, 60_000);
});
