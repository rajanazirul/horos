import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  accountDomain,
  BIND_TYPES,
  bindMessageFromRequest,
  BindRequest,
  errorEnvelope,
  ONBOARD_TYPES,
  onboardMessageFromRequest,
  OnboardingRequest,
  type ErrorCode,
  type Hex,
  type OnboardingResponse,
} from "@horos/schema";
import { getAddress, keccak256, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test, vi } from "vitest";
import type { CircleContractsClient, CircleWalletsClient } from "./circle.js";
import { deployPolicyWallet, formatDeployReport, type DeployPolicyWalletOptions, type DeployPublicClient, type DeployResult } from "./deploy.js";
import { HorosError } from "./errors.js";
import type { FetchLike } from "./internal.js";
import { STANDARD_PRESET } from "./preset.js";

// The unit tests cannot hold the real runtime code, so the pinned codehash is swapped for the hash of a stand-in code
// blob. The artifact-vs-fixture test below reads the real generated module.
vi.mock("./generated/policy-wallet-artifact.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./generated/policy-wallet-artifact.js")>();
  const { keccak256: k } = await import("viem");
  return { ...actual, expectedRuntimeCodehash: k("0x60806040deadbeef") };
});

const GOOD_CODE: Hex = "0x60806040deadbeef";
const CHAIN_ID = 5042002;
const BASE = "https://api.horos.test";
// Well-known Foundry/Anvil dev keys. Test-only; never funded on any real network.
const paymentAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const PAYMENT = paymentAccount.address.toLowerCase() as Hex;
const HUMAN: Hex = "0x3b60ebece31658efda2ad1cd28860cabbf2e4e85";
const REGISTRAR: Hex = "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc";
const MODEL: Hex = "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7";
const RULES: Hex = "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769";
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00";
const CUSTOMER = "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f10";
const T0 = Date.parse("2026-09-29T12:00:00.000Z");

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (code: ErrorCode, status: number, retryable?: boolean) => json(status, errorEnvelope(code, `${code} happened`, retryable));

const provisioned = (over: Partial<OnboardingResponse> = {}): OnboardingResponse => ({
  customerId: CUSTOMER,
  scope: SCOPE,
  status: "provisioned",
  registrar: REGISTRAR,
  model: MODEL,
  rules: RULES,
  ...over,
});
const provisioning = (): OnboardingResponse => ({ customerId: CUSTOMER, scope: SCOPE, status: "provisioning", registrar: null, model: null, rules: null });
const bound = (): OnboardingResponse => ({ ...provisioned(), status: "bound", policyWallet: WALLET });

type Reply = Response | Error;

interface Harness {
  readonly options: DeployPolicyWalletOptions;
  readonly calls: { url: string; body: unknown }[];
  readonly logs: string[];
  readonly circleCalls: { op: string; input: unknown }[];
  readonly deployCalls: unknown[];
  readonly sleeps: number[];
}

interface HarnessOpts {
  readonly onboard?: (n: number) => Reply;
  readonly bind?: (n: number) => Reply;
  readonly kind?: "circle" | "eoa";
  readonly humanAddress?: string;
  readonly humanCode?: Hex;
  readonly chainIdLive?: number;
  readonly walletChainId?: number;
  readonly blockchain?: string;
  readonly livePolicy?: Record<string, bigint>;
  readonly contracts?: CircleContractsClient;
  readonly circleOwnerWallets?: readonly { id: string; address: string }[];
  readonly circleWallet?: { id: string; address: string };
  readonly code?: Hex | undefined;
  readonly liveRoles?: Partial<Record<"human" | "payment" | "registrar" | "model" | "rules", Hex>>;
  readonly listWalletsError?: Error;
  readonly timeoutMs?: number;
}

/** A Circle Contracts fake with idempotency: one contract id per key; `script(id)` gives that contract's statuses per poll. */
function fakeContracts(script: (contractId: string) => readonly string[]) {
  const ids = new Map<string, string>();
  const polls = new Map<string, number>();
  const keys: string[] = [];
  const client: CircleContractsClient = {
    async deployContract(input) {
      const key = input.idempotencyKey ?? "";
      keys.push(key);
      let id = ids.get(key);
      if (id === undefined) {
        id = `c-${ids.size + 1}`;
        ids.set(key, id);
      }
      return { data: { contractId: id, transactionId: `t-${id}` } };
    },
    async getContract({ id }) {
      const n = polls.get(id) ?? 0;
      polls.set(id, n + 1);
      const statuses = script(id);
      const status = statuses[Math.min(n, statuses.length - 1)] ?? "PENDING";
      return { data: { contract: { id, status, ...(status === "COMPLETE" ? { contractAddress: "0x7ED77BDD025D461E15D8E85DBF3AB0E9A286774C" } : {}) } } };
    },
  };
  return { client, keys, ids };
}

function harness(o: HarnessOpts = {}): Harness {
  let clock = T0;
  const calls: { url: string; body: unknown }[] = [];
  const logs: string[] = [];
  const circleCalls: { op: string; input: unknown }[] = [];
  const deployCalls: unknown[] = [];
  const sleeps: number[] = [];
  let onboards = 0;
  let binds = 0;
  const fetch: FetchLike = async (url, init) => {
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, body });
    let r: Reply | undefined;
    if (url === `${BASE}/v1/onboarding`) r = (o.onboard ?? (() => json(200, provisioned())))(++onboards);
    else if (url === `${BASE}/v1/onboarding/bind`) r = (o.bind ?? (() => json(200, bound())))(++binds);
    if (r === undefined) throw new Error(`unexpected ${url}`);
    if (r instanceof Error) throw r;
    return r;
  };

  const wallets: CircleWalletsClient = {
    async listWallets(input) {
      circleCalls.push({ op: "listWallets", input });
      if (o.listWalletsError !== undefined) throw o.listWalletsError;
      return { data: { wallets: o.circleOwnerWallets ?? [] } };
    },
    async createWalletSet(input) {
      circleCalls.push({ op: "createWalletSet", input });
      return { data: { walletSet: { id: "ws-1" } } };
    },
    async createWallets(input) {
      circleCalls.push({ op: "createWallets", input });
      return { data: { wallets: [{ id: "w-pay", address: paymentAccount.address }] } };
    },
    async signTypedData(input) {
      circleCalls.push({ op: "signTypedData", input: { walletId: input.walletId } });
      const td = JSON.parse(input.data) as { types: Record<string, { name: string; type: string }[]>; domain: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
      const types = { ...td.types };
      delete types["EIP712Domain"];
      const fields = types[td.primaryType] ?? [];
      const message = Object.fromEntries(Object.entries(td.message).map(([k, v]) => [k, fields.find((f) => f.name === k)?.type.startsWith("uint") ? BigInt(v as string) : v]));
      return { data: { signature: await paymentAccount.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message } as never) } };
    },
  };
  const inner = o.contracts ?? fakeContracts(() => ["PENDING", "COMPLETE"]).client;
  const contracts: CircleContractsClient = {
    async deployContract(input) {
      circleCalls.push({ op: "deployContract", input });
      return inner.deployContract(input);
    },
    async getContract(input) {
      circleCalls.push({ op: "getContract", input });
      return inner.getContract(input);
    },
  };

  const roles = { human: HUMAN, payment: PAYMENT, registrar: REGISTRAR, model: MODEL, rules: RULES, ...o.liveRoles };
  const publicClient: DeployPublicClient = {
    async getChainId() {
      return o.chainIdLive ?? CHAIN_ID;
    },
    async getCode({ address }) {
      if (address !== WALLET) return o.humanCode;
      return "code" in o ? o.code : GOOD_CODE;
    },
    async readContract(args) {
      if (args.address !== WALLET) throw new Error("wrong address");
      if (args.functionName === "human") return roles.human;
      if (args.functionName === "policy") return { ...STANDARD_PRESET.onchain, ...o.livePolicy };
      return [roles.payment, roles.registrar, roles.model, roles.rules][args.args?.[0] ?? -1];
    },
    async waitForTransactionReceipt() {
      return { status: "success", contractAddress: WALLET };
    },
  };
  const walletClient = {
    chain: { id: o.walletChainId ?? CHAIN_ID },
    async deployContract(args: unknown) {
      deployCalls.push(args);
      return `0x${"ab".repeat(32)}` as Hex;
    },
  };

  const options: DeployPolicyWalletOptions = {
    baseUrl: `${BASE}/`,
    chainId: CHAIN_ID,
    humanAddress: o.humanAddress ?? HUMAN,
    payment:
      o.kind === "eoa"
        ? { kind: "eoa", account: paymentAccount, walletClient: walletClient as never }
        : {
            kind: "circle",
            wallets,
            contracts,
            ...(o.circleWallet === undefined ? {} : { wallet: o.circleWallet }),
            ...(o.blockchain === undefined ? {} : { blockchain: o.blockchain }),
          },
    publicClient,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (line) => logs.push(line),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  };
  return { options, calls, logs, circleCalls, deployCalls, sleeps };
}

async function rejection(p: Promise<unknown>): Promise<HorosError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HorosError);
    return err as HorosError;
  }
  throw new Error("expected a rejection");
}

async function recoverOnboard(body: unknown): Promise<string> {
  const req = OnboardingRequest.parse(body);
  return (await recoverTypedDataAddress({ domain: accountDomain(CHAIN_ID), types: ONBOARD_TYPES, primaryType: "Onboard", message: onboardMessageFromRequest(req), signature: req.auth?.signature ?? "0x" })).toLowerCase();
}
async function recoverBind(body: unknown): Promise<string> {
  const req = BindRequest.parse(body);
  return (await recoverTypedDataAddress({ domain: accountDomain(CHAIN_ID), types: BIND_TYPES, primaryType: "Bind", message: bindMessageFromRequest(req), signature: req.auth?.signature ?? "0x" })).toLowerCase();
}

const ops = (h: Harness) => h.circleCalls.map((c) => c.op).filter((op) => op !== "signTypedData" && op !== "getContract");

describe("deployPolicyWallet: Circle path", () => {
  test("creates the Payment EOA, onboards, deploys via Circle, verifies, binds and prints the report", async () => {
    const h = harness();
    const result = await deployPolicyWallet(h.options);

    expect(ops(h)).toEqual(["listWallets", "createWalletSet", "createWallets", "deployContract"]);
    expect(h.circleCalls[0]?.input).toEqual({ address: HUMAN });
    const createWallets = h.circleCalls.find((c) => c.op === "createWallets")?.input as Record<string, unknown>;
    expect(createWallets).toMatchObject({ walletSetId: "ws-1", blockchains: ["ARC-TESTNET"], count: 1, accountType: "EOA" });
    const deploy = h.circleCalls.find((c) => c.op === "deployContract")?.input as Record<string, unknown>;
    expect(deploy).toMatchObject({ walletId: "w-pay", blockchain: "ARC-TESTNET", fee: { type: "level", config: { feeLevel: "MEDIUM" } } });
    expect(deploy["constructorParameters"]).toEqual([[HUMAN, PAYMENT, REGISTRAR, MODEL, RULES], ["500000000", "5000000000", "10", "30", "86400"], false]);
    expect(typeof deploy["bytecode"]).toBe("string");
    expect(JSON.parse(deploy["abiJson"] as string)[0].type).toBe("constructor");
    for (const c of h.circleCalls.filter((x) => ["createWalletSet", "createWallets", "deployContract"].includes(x.op))) {
      expect((c.input as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }

    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/v1/onboarding`, `${BASE}/v1/onboarding/bind`]);
    expect(await recoverOnboard(h.calls[0]?.body)).toBe(PAYMENT);
    expect(await recoverBind(h.calls[1]?.body)).toBe(PAYMENT);
    expect((h.calls[1]?.body as { policy_wallet: string }).policy_wallet).toBe(WALLET);

    expect(result).toMatchObject({ policyWallet: WALLET, scope: SCOPE, customerId: CUSTOMER, codehash: keccak256(GOOD_CODE), circleWalletId: "w-pay" });
    expect(result.roles).toEqual({ human: HUMAN, payment: PAYMENT, registrar: REGISTRAR, model: MODEL, rules: RULES });
    expect(result.scope.startsWith("enforced:")).toBe(true);

    const report = h.logs.join("\n");
    const order = ["Codehash:", "Role holders", "Explorer:", "https://testnet.arcscan.app/address/", "Funding"].map((s) => report.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(report).not.toMatch(/you are compliant|makes you compliant/i);
  });

  test("an existing Circle wallet is used without creating one", async () => {
    const h = harness({ circleWallet: { id: "w-existing", address: paymentAccount.address } });
    const result = await deployPolicyWallet(h.options);
    expect(ops(h)).toEqual(["listWallets", "deployContract"]);
    expect(result.circleWalletId).toBe("w-existing");
  });

  test("the Human found in the same Circle account is refused before any create, deploy or onboard", async () => {
    const h = harness({ circleOwnerWallets: [{ id: "w-human", address: HUMAN }] });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("validation_failed");
    expect(err.message).toMatch(/custody separation/);
    expect(err.message).toMatch(/same Circle account/);
    expect(ops(h)).toEqual(["listWallets"]);
    expect(h.calls).toHaveLength(0);
  });

  test("an existing Circle wallet equal to the Human is refused", async () => {
    const h = harness({ circleWallet: { id: "w-1", address: HUMAN } });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.message).toMatch(/custody separation/);
    expect(ops(h)).toEqual(["listWallets"]);
    expect(h.calls).toHaveLength(0);
  });

  test("Circle errors are redacted to their name", async () => {
    const e = new Error("401 Authorization: Bearer TEST_API_KEY:secret");
    e.name = "CircleApiError";
    const h = harness({ listWalletsError: e });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.message).toBe("Circle listWallets failed: CircleApiError");
    expect(err.message).not.toMatch(/secret|Bearer/);
  });

  test("a failed Circle deploy stops before verify and bind", async () => {
    const h = harness({ contracts: fakeContracts(() => ["PENDING", "FAILED"]).client });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.message).toMatch(/failed/);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/v1/onboarding`]);
  });

  test("a rerun after success reuses the same idempotency keys and the bound wallet; bind answers 200", async () => {
    const first = harness();
    await deployPolicyWallet(first.options);
    const again = harness({ onboard: () => json(200, bound()) });
    const result = await deployPolicyWallet(again.options);
    const keys = (h: Harness) => h.circleCalls.filter((c) => c.op === "createWalletSet" || c.op === "createWallets").map((c) => (c.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys(again)).toEqual(keys(first));
    expect(ops(again)).not.toContain("deployContract");
    expect(result.policyWallet).toBe(WALLET);
    expect(again.calls.map((c) => c.url)).toEqual([`${BASE}/v1/onboarding`, `${BASE}/v1/onboarding/bind`]);
  });
});

describe("deployPolicyWallet: existing EOA path", () => {
  test("deploys with viem from the Payment account, verifies and binds", async () => {
    const h = harness({ kind: "eoa" });
    const result = await deployPolicyWallet(h.options);
    expect(h.deployCalls).toHaveLength(1);
    const args = h.deployCalls[0] as { args: unknown[]; account: { address: string } };
    expect(args.account.address).toBe(paymentAccount.address);
    expect(args.args).toEqual([
      { human: HUMAN, payment: PAYMENT, registrar: REGISTRAR, model: MODEL, rules: RULES },
      { firstContactCeiling: 500_000_000n, walletPeriodCap: 5_000_000_000n, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n },
      false,
    ]);
    expect(h.circleCalls).toHaveLength(0);
    expect(await recoverOnboard(h.calls[0]?.body)).toBe(PAYMENT);
    expect(result).toMatchObject({ policyWallet: WALLET, scope: SCOPE });
  });

  test("Human = Payment is refused before any network call", async () => {
    const h = harness({ kind: "eoa", humanAddress: paymentAccount.address });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("validation_failed");
    expect(err.message).toMatch(/custody separation/);
    expect(h.calls).toHaveLength(0);
    expect(h.deployCalls).toHaveLength(0);
  });

  test("Human = a Horos role address is refused before deploy", async () => {
    const h = harness({ kind: "eoa", onboard: () => json(200, provisioned({ model: HUMAN })) });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("validation_failed");
    expect(err.message).toMatch(/Horos role/);
    expect(h.deployCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
  });

  test("invalid Human address and webhook are refused before any network call", async () => {
    const h = harness({ kind: "eoa", humanAddress: "0x1234" });
    expect((await rejection(deployPolicyWallet(h.options))).code).toBe("validation_failed");
    const z = harness({ kind: "eoa", humanAddress: `0x${"0".repeat(40)}` });
    expect((await rejection(deployPolicyWallet(z.options))).code).toBe("validation_failed");
    const w = harness({ kind: "eoa" });
    expect((await rejection(deployPolicyWallet({ ...w.options, webhookUrl: "ftp://nope" }))).code).toBe("validation_failed");
    expect([...h.calls, ...z.calls, ...w.calls]).toHaveLength(0);
  });
});

describe("onboarding provisioning", () => {
  test("202 then 200: re-POSTs the Payment-signed request until provisioned", async () => {
    const h = harness({ kind: "eoa", onboard: (n) => (n < 3 ? json(202, provisioning()) : json(200, provisioned())) });
    await deployPolicyWallet(h.options);
    const onboards = h.calls.filter((c) => c.url.endsWith("/v1/onboarding"));
    expect(onboards).toHaveLength(3);
    for (const c of onboards) expect(await recoverOnboard(c.body)).toBe(PAYMENT);
    expect(h.sleeps.slice(0, 2)).toEqual([2000, 2000]);
  });

  test("a long provisioning wait re-signs with a fresh nonce once the envelope nears expiry", async () => {
    const h = harness({ kind: "eoa", onboard: (n) => (n < 60 ? json(202, provisioning()) : json(200, provisioned())) });
    await deployPolicyWallet(h.options);
    const nonces = new Set(h.calls.filter((c) => c.url.endsWith("/v1/onboarding")).map((c) => (c.body as { auth: { nonce: string } }).auth.nonce));
    expect(nonces.size).toBeGreaterThan(1);
    expect(nonces.size).toBeLessThan(5);
  });

  test("still provisioning at the timeout: retryable unavailable, nothing deployed", async () => {
    const h = harness({ kind: "eoa", onboard: () => json(202, provisioning()), timeoutMs: 10_000 });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("unavailable");
    expect(err.retryable).toBe(true);
    expect(h.deployCalls).toHaveLength(0);
  });

  test("a non-retryable onboarding error stops at once", async () => {
    const h = harness({ kind: "eoa", onboard: () => envelope("unauthenticated", 401) });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("unauthenticated");
    expect(h.calls).toHaveLength(1);
  });
});

describe("post-deploy verification", () => {
  test("codehash mismatch: conflict, no bind, no report or funding instructions", async () => {
    const h = harness({ code: "0x6001" });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/codehash mismatch/);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/v1/onboarding`]);
    const logs = h.logs.join("\n");
    expect(logs).not.toMatch(/Codehash:|Role holders|Explorer:|Funding/);
  });

  test("no code at the address: conflict", async () => {
    const h = harness({ kind: "eoa", code: undefined });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.message).toMatch(/no code/);
    expect(h.calls).toHaveLength(1);
  });

  test("role mismatch: conflict naming the role, no bind, no funding instructions", async () => {
    const h = harness({ kind: "eoa", liveRoles: { rules: "0x1111111111111111111111111111111111111111" } });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/role mismatch: rules at /);
    expect(h.calls).toHaveLength(1);
    expect(h.logs.join("\n")).not.toMatch(/Funding/);
  });
});

describe("bind", () => {
  test("409 retryable while keys provision: retried with backoff until 200", async () => {
    const h = harness({ kind: "eoa", bind: (n) => (n < 3 ? envelope("conflict", 409, true) : json(200, bound())) });
    const result = await deployPolicyWallet(h.options);
    expect(h.calls.filter((c) => c.url.endsWith("/bind"))).toHaveLength(3);
    expect(h.sleeps.slice(-2)).toEqual([250, 500]);
    expect(result.scope).toBe(SCOPE);
  });

  test("retryable until the timeout: the final envelope error", async () => {
    const h = harness({ kind: "eoa", bind: () => envelope("conflict", 409, true), timeoutMs: 5_000 });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("conflict");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(409);
    expect(h.logs.join("\n")).not.toMatch(/Funding/);
  });

  test("422 role mismatch stops with the api code", async () => {
    const h = harness({ kind: "eoa", bind: () => json(422, errorEnvelope("validation_failed", "role mismatch: human")) });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("validation_failed");
    expect(err.status).toBe(422);
    expect(h.calls.filter((c) => c.url.endsWith("/bind"))).toHaveLength(1);
  });

  test("409 bound to another wallet stops", async () => {
    const h = harness({ kind: "eoa", bind: () => envelope("conflict", 409) });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("conflict");
    expect(err.retryable).toBe(false);
    expect(h.calls.filter((c) => c.url.endsWith("/bind"))).toHaveLength(1);
  });
});

describe("fail-closed gates", () => {
  const noFunding = (h: Harness) => expect(h.logs.join("\n")).not.toMatch(/Funding/);

  test("onboarding returns a non-enforced Scope: conflict before deploy", async () => {
    const h = harness({ kind: "eoa", onboard: () => json(200, provisioned({ scope: "shadow:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00" })) });
    expect((await rejection(deployPolicyWallet(h.options))).code).toBe("conflict");
    expect(h.deployCalls).toHaveLength(0);
  });

  test("a Horos role equal to the Payment address: conflict before deploy", async () => {
    const h = harness({ kind: "eoa", onboard: () => json(200, provisioned({ registrar: PAYMENT })) });
    expect((await rejection(deployPolicyWallet(h.options))).code).toBe("conflict");
    expect(h.deployCalls).toHaveLength(0);
  });

  test("Human = the USDC address is refused before any call", async () => {
    const h = harness({ kind: "eoa", humanAddress: "0x3600000000000000000000000000000000000000" });
    expect((await rejection(deployPolicyWallet(h.options))).code).toBe("validation_failed");
    expect(h.calls).toHaveLength(0);
  });

  test("a contract Human address is refused before any create, deploy or onboard (EOA only in v1)", async () => {
    const h = harness({ humanCode: "0x6080" });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("validation_failed");
    expect(err.message).toMatch(/must be an EOA/);
    expect(h.circleCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  test.each([
    ["publicClient on another chain", { kind: "eoa" as const, chainIdLive: 1 }],
    ["walletClient on another chain", { kind: "eoa" as const, walletChainId: 1 }],
    ["Circle blockchain not mapped to chainId", { blockchain: "ETH-SEPOLIA" }],
  ])("chain mismatch refused before any write: %s", async (_name, opts) => {
    const h = harness(opts);
    expect((await rejection(deployPolicyWallet(h.options))).code).toBe("validation_failed");
    expect(h.calls).toHaveLength(0);
    expect(h.deployCalls).toHaveLength(0);
    expect(h.circleCalls).toHaveLength(0);
  });

  test("a chainId with no known Circle blockchain is refused on the Circle path", async () => {
    const h = harness({ chainIdLive: 31337 });
    const err = await rejection(deployPolicyWallet({ ...h.options, chainId: 31337 }));
    expect(err.message).toMatch(/no Circle blockchain/);
    expect(h.circleCalls).toHaveLength(0);
  });

  test.each([
    ["status not bound", () => json(200, { ...bound(), status: "provisioned" })],
    ["non-enforced Scope", () => json(200, { ...bound(), scope: "shadow:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00" })],
    ["a different policyWallet", () => json(200, { ...bound(), policyWallet: "0x1111111111111111111111111111111111111111" })],
    ["no policyWallet", () => json(200, { ...provisioned(), status: "bound" })],
  ])("bind 200 with %s: conflict, no funding instructions", async (_name, reply) => {
    const h = harness({ kind: "eoa", bind: reply });
    expect((await rejection(deployPolicyWallet(h.options))).code).toBe("conflict");
    noFunding(h);
  });

  test("Policy read back differs from the standard Preset: conflict, no bind", async () => {
    const h = harness({ kind: "eoa", livePolicy: { unpinDelay: 3600n } });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/Policy mismatch: unpinDelay/);
    expect(h.calls).toHaveLength(1);
    noFunding(h);
  });

  test("errors after an EOA deploy carry the tx hash and contract address", async () => {
    const h = harness({ kind: "eoa", bind: () => envelope("conflict", 409) });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.message).toContain(`deploy tx 0x${"ab".repeat(32)}`);
    expect(err.message).toContain(`PolicyWallet ${WALLET}`);
  });

  test("already-bound EOA rerun re-verifies and re-binds without deploying", async () => {
    const h = harness({ kind: "eoa", onboard: () => json(200, bound()) });
    const result = await deployPolicyWallet(h.options);
    expect(h.deployCalls).toHaveLength(0);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/v1/onboarding`, `${BASE}/v1/onboarding/bind`]);
    expect(result.policyWallet).toBe(WALLET);
    expect(result.deployTxHash).toBeUndefined();
  });

  test("role drift on an already-bound wallet is reported as drift, not 'do not fund'", async () => {
    const h = harness({ kind: "eoa", onboard: () => json(200, bound()), liveRoles: { rules: "0x1111111111111111111111111111111111111111" } });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.message).toMatch(/drift on the live, already-bound PolicyWallet/);
    expect(err.message).not.toMatch(/do not fund/);
    expect(h.calls).toHaveLength(1);
  });

  test("a deterministic deploy failure is not retryable; a transport error is", async () => {
    const revert = Object.assign(new Error("execution reverted"), { name: "ContractFunctionExecutionError" });
    const h = harness({ kind: "eoa" });
    const failing = { ...h.options, payment: { kind: "eoa" as const, account: paymentAccount, walletClient: { chain: { id: CHAIN_ID }, deployContract: async () => Promise.reject(revert) } as never } };
    expect((await rejection(deployPolicyWallet(failing))).retryable).toBe(false);
    const net = Object.assign(new Error("wrap", { cause: Object.assign(new Error("x"), { name: "HttpRequestError" }) }), { name: "TransactionExecutionError" });
    const flaky = { ...h.options, payment: { kind: "eoa" as const, account: paymentAccount, walletClient: { chain: { id: CHAIN_ID }, deployContract: async () => Promise.reject(net) } as never } };
    expect((await rejection(deployPolicyWallet(flaky))).retryable).toBe(true);
  });
});

describe("Circle deploy records", () => {
  test("PENDING past the timeout: retryable unavailable, no bind", async () => {
    const h = harness({ contracts: fakeContracts(() => ["PENDING"]).client, timeoutMs: 10_000 });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.code).toBe("unavailable");
    expect(err.retryable).toBe(true);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/v1/onboarding`]);
  });

  test("COMPLETE without a contract address fails at once", async () => {
    const client: CircleContractsClient = {
      deployContract: async () => ({ data: { contractId: "c-1" } }),
      getContract: async () => ({ data: { contract: { id: "c-1", status: "COMPLETE" } } }),
    };
    const h = harness({ contracts: client });
    const err = await rejection(deployPolicyWallet(h.options));
    expect(err.message).toMatch(/COMPLETE without a valid contract address/);
    expect(h.sleeps).toHaveLength(0);
  });

  test("two runs with onboarding provisioned both times send the identical deploy key", async () => {
    const a = fakeContracts(() => ["PENDING", "COMPLETE"]);
    await deployPolicyWallet(harness({ contracts: a.client }).options);
    await deployPolicyWallet(harness({ contracts: a.client }).options);
    expect(a.keys).toHaveLength(2);
    expect(a.keys[0]).toBe(a.keys[1]);
    expect(a.ids.size).toBe(1);
  });

  test("the deploy key changes with the roles", async () => {
    const a = fakeContracts(() => ["PENDING", "COMPLETE"]);
    await deployPolicyWallet(harness({ contracts: a.client }).options);
    await rejection(deployPolicyWallet(harness({ contracts: a.client, onboard: () => json(200, provisioned({ rules: "0x2222222222222222222222222222222222222222" })) }).options));
    expect(a.keys[0]).not.toBe(a.keys[1]);
  });

  test("a deploy that fails in this run throws with its contract id; the rerun moves to the next key and submits one deploy", async () => {
    const circle = fakeContracts((id) => (id === "c-1" ? ["PENDING", "FAILED"] : ["PENDING", "COMPLETE"]));
    const first = await rejection(deployPolicyWallet(harness({ contracts: circle.client }).options));
    expect(first.retryable).toBe(false);
    expect(first.message).toMatch(/c-1 failed/);
    const result = await deployPolicyWallet(harness({ contracts: circle.client }).options);
    expect(result.policyWallet).toBe(WALLET);
    expect(circle.keys).toHaveLength(3);
    expect(circle.keys[1]).toBe(circle.keys[0]);
    expect(circle.keys[2]).not.toBe(circle.keys[0]);
    expect(circle.ids.size).toBe(2); // exactly one new deploy in the rerun
  });
});

describe("request signing", () => {
  test("a pending onboarding reuses the signed body until it nears expiry", async () => {
    const h = harness({ onboard: (n) => (n < 6 ? json(202, provisioning()) : json(200, provisioned())) });
    await deployPolicyWallet(h.options);
    expect(h.calls.filter((c) => c.url.endsWith("/v1/onboarding"))).toHaveLength(6);
    const bodies = new Set(h.calls.filter((c) => c.url.endsWith("/v1/onboarding")).map((c) => JSON.stringify(c.body)));
    expect(bodies.size).toBe(1);
    // one Onboard signature (6 POSTs 2 s apart fit in one 120 s envelope) and one Bind signature
    expect(h.circleCalls.filter((c) => c.op === "signTypedData")).toHaveLength(2);
  });
});

describe("report", () => {
  test("codehash, role holders, explorer links, then funding, with EIP-55 addresses", () => {
    const result: DeployResult = {
      policyWallet: WALLET,
      scope: SCOPE,
      customerId: CUSTOMER,
      codehash: `0x${"11".repeat(32)}`,
      roles: { human: HUMAN, payment: PAYMENT, registrar: REGISTRAR, model: MODEL, rules: RULES },
      policy: STANDARD_PRESET.onchain,
      chainId: CHAIN_ID,
      explorerUrl: "https://testnet.arcscan.app",
    };
    const text = formatDeployReport(result);
    expect(text).toContain(`https://testnet.arcscan.app/address/${getAddress(WALLET)}`);
    const i = (s: string) => text.indexOf(s);
    expect(i("Codehash:")).toBeLessThan(i("Role holders"));
    expect(i("Role holders")).toBeLessThan(i("Policy (read back"));
    expect(i("Policy (read back")).toBeLessThan(i("Explorer:"));
    expect(text).toContain("first-contact ceiling  500 USDC");
    expect(i("Explorer:")).toBeLessThan(i("Funding"));
    for (const r of ["human", "payment", "registrar", "model", "rules"]) expect(text).toMatch(new RegExp(`^  ${r} `, "m"));
  });
});

describe("pinned values", () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/horos-demo-wallet.json", import.meta.url)), "utf8")) as {
    codehash: string;
    policy: Record<string, string>;
  };

  test("STANDARD_PRESET equals the Demo wallet fixture's Policy", () => {
    const p = STANDARD_PRESET.onchain;
    expect({
      firstContactCeiling: p.firstContactCeiling.toString(),
      walletPeriodCap: p.walletPeriodCap.toString(),
      newPayeeCap: p.newPayeeCap.toString(),
      policyPeriodDays: p.policyPeriodDays.toString(),
      unpinDelay: p.unpinDelay.toString(),
    }).toEqual(fixture.policy);
  });

  test("the generated expectedRuntimeCodehash equals the Demo fixture codehash", async () => {
    const actual = await vi.importActual<typeof import("./generated/policy-wallet-artifact.js")>("./generated/policy-wallet-artifact.js");
    expect(actual.expectedRuntimeCodehash).toBe(fixture.codehash);
    expect(actual.policyWalletBytecode).toMatch(/^0x[0-9a-f]+$/);
  });
});
