// The real viem wiring (no network: clients are lazy) and a drift check of the hand-copied PAY_ABI against the SDK's
// generated PolicyWallet ABI.
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { chainFor, PAY_ABI, publicClientFor, walletClientFor } from "./chain.js";
import { KEY } from "./harness.test-helpers.js";
import { paymentAccountFromEnv } from "./env.js";
import { BLOCKING_REVERTS } from "./smoke.js";

interface AbiItem {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly { readonly type: string }[];
}

const GENERATED = fileURLToPath(new URL("../../sdk/src/generated/policy-wallet-artifact.ts", import.meta.url));

test("PAY_ABI matches the SDK's generated PolicyWallet ABI (pay signature, every error used)", async () => {
  const { policyWalletAbi } = (await import(pathToFileURL(GENERATED).href)) as { policyWalletAbi: readonly AbiItem[] };
  const sig = (i: AbiItem) => `${i.name ?? ""}(${(i.inputs ?? []).map((x) => x.type).join(",")})`;
  const generated = new Map(policyWalletAbi.map((i) => [`${i.type}:${sig(i)}`, i]));
  for (const item of PAY_ABI as readonly AbiItem[]) expect(generated.has(`${item.type}:${sig(item)}`), `${item.type} ${sig(item)}`).toBe(true);
  const errors = new Set(policyWalletAbi.filter((i) => i.type === "error").map((i) => i.name));
  for (const name of [...BLOCKING_REVERTS, "Unauthorized"]) {
    expect(errors.has(name), name).toBe(true);
    expect(PAY_ABI.some((i) => i.type === "error" && i.name === name), name).toBe(true);
  }
});

test("chainFor: Arc testnet by default, an RPC override, and a custom chain only with an RPC URL", () => {
  const arc = chainFor(5042002, undefined);
  expect(arc.id).toBe(5042002);
  expect(arc.rpcUrls.default.http[0]).toMatch(/^https:\/\//);
  expect(chainFor(5042002, "https://rpc.example/arc").rpcUrls.default.http).toEqual(["https://rpc.example/arc"]);
  expect(chainFor(31337, "http://127.0.0.1:8545")).toMatchObject({ id: 31337, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } });
  expect(() => chainFor(31337, undefined)).toThrow(/RPC URL is required/);
});

test("clients: http for http(s) RPCs, webSocket for ws(s); on the configured chain", () => {
  const type = (c: unknown) => (c as { transport: { type: string } }).transport.type;
  const chainId = (c: unknown) => (c as { chain: { id: number } }).chain.id;
  expect(type(publicClientFor(5042002, undefined))).toBe("http");
  expect(type(publicClientFor(5042002, "https://rpc.example"))).toBe("http");
  expect(type(publicClientFor(5042002, "wss://rpc.example"))).toBe("webSocket");
  const account = paymentAccountFromEnv({ HOROS_PAYMENT_PRIVATE_KEY: KEY });
  const wallet = walletClientFor(31337, "http://127.0.0.1:8545", account);
  expect(wallet.chain?.id).toBe(31337);
  expect(chainId(publicClientFor(31337, "ws://127.0.0.1:8545"))).toBe(31337);
});
