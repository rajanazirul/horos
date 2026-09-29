import { PGlite } from "@electric-sql/pglite";
import { PostgresAccountStore, PostgresPolicyVersionStore, runMigrations } from "@horos/adapters";
import type { ChainReader, ProvisionedKeys, WalletRoles } from "@horos/core";
import {
  accountDomain,
  BIND_TYPES,
  ErrorEnvelope,
  ONBOARD_TYPES,
  OnboardingResponse,
  WEBHOOK_UPDATE_TYPES,
  type Hex,
} from "@horos/schema";
import { drizzle } from "drizzle-orm/pglite";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { uuidv7 } from "./index.js";

const TOKEN = "test-admin-token-not-a-secret";
const CHAIN_ID = 5042002;
// Well-known Foundry/Anvil dev keys. Test-only; never funded on any real network.
const payment = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const PAY = payment.address.toLowerCase() as Hex;
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const HUMAN: Hex = "0x3b60ebece31658efda2ad1cd28860cabbf2e4e85";
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-r", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-m", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-u", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};
const NOW = new Date("2026-09-28T12:00:00.000Z");
const EXPIRY = "2026-09-28T12:04:00.000Z";
const expirySec = BigInt(Date.parse(EXPIRY) / 1000);
const nonce = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const domain = accountDomain(CHAIN_ID);

class FakeReader implements ChainReader {
  roleMap: WalletRoles = { payment: PAY, registrar: KEYS.registrar.address, model: KEYS.model.address, rules: KEYS.rules.address, human: HUMAN };
  code = true;
  rolesDown = false;
  async remaining(): Promise<never> {
    throw new Error("unused");
  }
  async roles() {
    if (this.rolesDown) throw new Error("rpc down");
    return this.roleMap;
  }
  async policy(): Promise<never> {
    throw new Error("unused");
  }
  async hasCode() {
    return this.code;
  }
  async simulate(): Promise<never> {
    throw new Error("unused");
  }
  async latestBlock(): Promise<never> {
    throw new Error("unused");
  }
  async logs(): Promise<never> {
    throw new Error("unused");
  }
  async blockTimestamp(): Promise<never> {
    throw new Error("unused");
  }
  async txFrom(): Promise<never> {
    throw new Error("unused");
  }
  async rolesAt(): Promise<never> {
    throw new Error("unused");
  }
  async hasCodeAt(): Promise<never> {
    throw new Error("unused");
  }
}

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

async function setup(opts: { provisionWaitMs?: number; onSleep?: () => Promise<void> } = {}) {
  const client = new PGlite();
  clients.push(client);
  const db = drizzle(client);
  await runMigrations(db);
  const accounts = new PostgresAccountStore(db);
  const reader = new FakeReader();
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    policyVersions: new PostgresPolicyVersionStore(db),
    adminToken: TOKEN,
    now: () => NOW,
    newId: () => uuidv7(),
    accounts,
    chainReader: reader,
    chainId: CHAIN_ID,
    provisionWaitMs: opts.provisionWaitMs ?? 0,
    sleep: async () => {
      await opts.onSleep?.();
    },
    log: (e) => logs.push(e),
  });
  const count = async (table: string) => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n;
  return { app, accounts, reader, logs, count, client };
}

type App = Awaited<ReturnType<typeof setup>>["app"];
const send = (app: App, method: string, path: string, body: unknown, auth?: string) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(auth === undefined ? {} : { authorization: auth }) },
    body: JSON.stringify(body),
  });

async function signedOnboard(webhookUrl = "https://hooks.example.com/h?token=secret", signer = payment, n = 1, expiry = EXPIRY) {
  const exp = BigInt(Date.parse(expiry) / 1000);
  const signature = await signer.signTypedData({
    domain,
    types: ONBOARD_TYPES,
    primaryType: "Onboard",
    message: { paymentAddress: PAY, webhookUrl, nonce: nonce(n), expiry: exp },
  });
  return { payment_address: PAY, webhook_url: webhookUrl, auth: { nonce: nonce(n), expiry, signature } };
}

async function signedBind(signer = payment, n = 2) {
  const signature = await signer.signTypedData({
    domain,
    types: BIND_TYPES,
    primaryType: "Bind",
    message: { paymentAddress: PAY, policyWallet: WALLET, nonce: nonce(n), expiry: expirySec },
  });
  return { payment_address: PAY, policy_wallet: WALLET, auth: { nonce: nonce(n), expiry: EXPIRY, signature } };
}

async function signedWebhook(url: string, signer = payment, n = 3) {
  const signature = await signer.signTypedData({
    domain,
    types: WEBHOOK_UPDATE_TYPES,
    primaryType: "WebhookUpdate",
    message: { policyWallet: WALLET, webhookUrl: url, nonce: nonce(n), expiry: expirySec },
  });
  return { policy_wallet: WALLET, webhook_url: url, auth: { nonce: nonce(n), expiry: EXPIRY, signature } };
}

async function expectError(res: Response, status: number, code: string, retryable?: boolean) {
  expect(res.status).toBe(status);
  const body = ErrorEnvelope.parse(await res.json());
  expect(body.error.code).toBe(code);
  if (retryable !== undefined) expect(body.error.retryable).toBe(retryable);
  return body.error.message;
}

describe("POST /v1/onboarding", () => {
  test("new: 202 provisioning, then 200 with three distinct addresses once the worker has provisioned", async () => {
    const { app, accounts, count } = await setup();
    const res = await send(app, "POST", "/v1/onboarding", await signedOnboard());
    expect(res.status).toBe(202);
    const first = OnboardingResponse.parse(await res.json());
    expect(first).toMatchObject({ status: "provisioning", registrar: null, model: null, rules: null });
    expect(first.scope).toMatch(/^enforced:/);
    await accounts.setKeys(first.customerId, KEYS, NOW); // the worker's provision-keys job
    const again = await send(app, "POST", "/v1/onboarding", await signedOnboard(undefined, payment, 9));
    expect(again.status).toBe(200);
    const second = OnboardingResponse.parse(await again.json());
    expect(second).toEqual({
      customerId: first.customerId,
      scope: first.scope,
      status: "provisioned",
      registrar: KEYS.registrar.address,
      model: KEYS.model.address,
      rules: KEYS.rules.address,
    });
    expect([await count("customer"), await count("customer_webhook"), await count("enforced_binding"), await count("job")]).toEqual([1, 1, 1, 1]);
  });

  test("waits for provisioning up to provisionWaitMs and returns 200 when keys arrive", async () => {
    const hook: { provision?: () => Promise<void> } = {};
    const { app, accounts } = await setup({ provisionWaitMs: 8000, onSleep: async () => hook.provision?.() });
    hook.provision = async () => {
      const b = await accounts.bindingByPayment(PAY);
      if (b !== undefined && b.keys === null) await accounts.setKeys(b.customerId, KEYS, NOW);
    };
    const res = await send(app, "POST", "/v1/onboarding", await signedOnboard());
    expect(res.status).toBe(200);
    expect(OnboardingResponse.parse(await res.json()).status).toBe("provisioned");
  });

  test("bad signature or expiry beyond 300s → 401 and nothing written", async () => {
    const { app, count } = await setup();
    await expectError(await send(app, "POST", "/v1/onboarding", await signedOnboard(undefined, stranger)), 401, "unauthenticated");
    await expectError(await send(app, "POST", "/v1/onboarding", await signedOnboard(undefined, payment, 1, "2026-09-28T12:05:01.000Z")), 401, "unauthenticated");
    await expectError(await send(app, "POST", "/v1/onboarding", await signedOnboard(undefined, payment, 1, "2026-09-28T11:59:00.000Z")), 401, "unauthenticated");
    await expectError(await send(app, "POST", "/v1/onboarding", { payment_address: PAY }), 401, "unauthenticated");
    expect(await count("customer")).toBe(0);
  });

  test("admin bearer without a signature onboards; a wrong token is 401", async () => {
    const { app, count } = await setup();
    await expectError(await send(app, "POST", "/v1/onboarding", { payment_address: PAY }, "Bearer wrong"), 401, "unauthenticated");
    const res = await send(app, "POST", "/v1/onboarding", { payment_address: PAY }, `Bearer ${TOKEN}`);
    expect(res.status).toBe(202);
    expect(await count("customer")).toBe(1);
  });

  test("validation: bad JSON, bad webhook URL", async () => {
    const { app } = await setup();
    const bad = await app.request("/v1/onboarding", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    await expectError(bad, 400, "validation_failed");
    await expectError(await send(app, "POST", "/v1/onboarding", { payment_address: PAY, webhook_url: "http://example.com/" }, `Bearer ${TOKEN}`), 400, "validation_failed");
  });

  test("logs carry the webhook as origin + pathname only", async () => {
    const { app, logs } = await setup();
    await send(app, "POST", "/v1/onboarding", await signedOnboard());
    expect(JSON.stringify(logs)).not.toContain("secret");
    expect(logs[0]).toMatchObject({ event: "onboarding", webhook: "https://hooks.example.com/h" });
  });
});

describe("POST /v1/onboarding/bind", () => {
  async function onboarded(opts: { keys?: boolean } = {}) {
    const s = await setup();
    const res = await send(s.app, "POST", "/v1/onboarding", await signedOnboard());
    const { customerId } = OnboardingResponse.parse(await res.json());
    if (opts.keys !== false) await s.accounts.setKeys(customerId, KEYS, NOW);
    return { ...s, customerId };
  }

  test("ok: creates the enforced scope row and marks the binding bound; re-binding is idempotent", async () => {
    const { app, client } = await onboarded();
    const res = await send(app, "POST", "/v1/onboarding/bind", await signedBind());
    expect(res.status).toBe(200);
    const body = OnboardingResponse.parse(await res.json());
    expect(body).toMatchObject({ status: "bound", policyWallet: WALLET });
    const scopes = await client.query(`SELECT id, kind, policy_wallet FROM scope`);
    expect(scopes.rows).toEqual([{ id: body.scope, kind: "enforced", policy_wallet: WALLET }]);
    const again = await send(app, "POST", "/v1/onboarding/bind", await signedBind(payment, 7));
    expect(again.status).toBe(200);
    expect(OnboardingResponse.parse(await again.json())).toEqual(body);
  });

  test("mismatch: on-chain rules differ → 422 naming rules, no scope row", async () => {
    const { app, reader, count } = await onboarded();
    reader.roleMap = { ...reader.roleMap, rules: `0x${"4".repeat(40)}` };
    expect(await expectError(await send(app, "POST", "/v1/onboarding/bind", await signedBind()), 422, "validation_failed")).toBe("role mismatch: rules");
    expect(await count("scope")).toBe(0);
  });

  test.each([
    ["payment", { payment: `0x${"5".repeat(40)}` }],
    ["registrar", { registrar: `0x${"5".repeat(40)}` }],
    ["model", { model: `0x${"5".repeat(40)}` }],
    ["human", { human: KEYS.registrar.address }],
  ] as const)("mismatch names %s", async (role, patch) => {
    const { app, reader } = await onboarded();
    reader.roleMap = { ...reader.roleMap, ...(patch as Partial<WalletRoles>) };
    expect(await expectError(await send(app, "POST", "/v1/onboarding/bind", await signedBind()), 422, "validation_failed")).toBe(`role mismatch: ${role}`);
  });

  test("while provisioning → 409 conflict (retryable); no code → 422; bad signature → 401", async () => {
    const s = await onboarded({ keys: false });
    await expectError(await send(s.app, "POST", "/v1/onboarding/bind", await signedBind()), 409, "conflict", true);
    await s.accounts.setKeys(s.customerId, KEYS, NOW);
    s.reader.code = false;
    await expectError(await send(s.app, "POST", "/v1/onboarding/bind", await signedBind()), 422, "validation_failed");
    await expectError(await send(s.app, "POST", "/v1/onboarding/bind", await signedBind(stranger)), 401, "unauthenticated");
  });

  test("no onboarding → 404 not_found; roles RPC down → 503 unavailable (retryable); bound elsewhere → 409 conflict", async () => {
    const fresh = await setup();
    await expectError(await send(fresh.app, "POST", "/v1/onboarding/bind", await signedBind()), 404, "not_found", false);
    const s = await onboarded();
    s.reader.rolesDown = true;
    await expectError(await send(s.app, "POST", "/v1/onboarding/bind", await signedBind()), 503, "unavailable", true);
    s.reader.rolesDown = false;
    expect((await send(s.app, "POST", "/v1/onboarding/bind", await signedBind())).status).toBe(200);
    const other = { payment_address: PAY, policy_wallet: `0x${"6".repeat(40)}` };
    await expectError(await send(s.app, "POST", "/v1/onboarding/bind", other, `Bearer ${TOKEN}`), 409, "conflict", false);
  });

  test("admin bearer binds without a signature", async () => {
    const { app } = await onboarded();
    const res = await send(app, "POST", "/v1/onboarding/bind", { payment_address: PAY, policy_wallet: WALLET }, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });
});

describe("PUT /v1/webhook", () => {
  async function bound() {
    const s = await setup();
    const res = await send(s.app, "POST", "/v1/onboarding", await signedOnboard());
    const { customerId } = OnboardingResponse.parse(await res.json());
    await s.accounts.setKeys(customerId, KEYS, NOW);
    expect((await send(s.app, "POST", "/v1/onboarding/bind", await signedBind())).status).toBe(200);
    return { ...s, customerId };
  }

  test("signed by the live Payment key: new webhook row; logs show no query string; a replayed nonce is 401", async () => {
    const { app, accounts, customerId, logs, count } = await bound();
    const body = await signedWebhook("https://new.example.com/hook?sig=topsecret");
    const res = await send(app, "PUT", "/v1/webhook", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customerId, webhook: "https://new.example.com/hook" });
    expect(await accounts.webhookUrl(customerId)).toBe("https://new.example.com/hook?sig=topsecret");
    expect(await count("customer_webhook")).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("topsecret");
    const replay = await send(app, "PUT", "/v1/webhook", body);
    expect(await expectError(replay, 401, "unauthenticated")).toBe("nonce already used");
    expect(await count("customer_webhook")).toBe(2);
  });

  test("a key other than the live Payment key → 401; the live key moved → old signer rejected", async () => {
    const { app, reader } = await bound();
    await expectError(await send(app, "PUT", "/v1/webhook", await signedWebhook("https://x.example.com/", stranger)), 401, "unauthenticated");
    reader.roleMap = { ...reader.roleMap, payment: stranger.address.toLowerCase() as Hex };
    await expectError(await send(app, "PUT", "/v1/webhook", await signedWebhook("https://x.example.com/", payment, 11)), 401, "unauthenticated");
    expect((await send(app, "PUT", "/v1/webhook", await signedWebhook("https://x.example.com/", stranger, 12))).status).toBe(200);
  });

  test("unbound wallets answer the same 401 as a bad signature (the binding is looked up only after the signature)", async () => {
    const b = await bound();
    const badOnBound = await expectError(await send(b.app, "PUT", "/v1/webhook", await signedWebhook("https://x.example.com/", stranger)), 401, "unauthenticated");
    const s = await setup();
    await send(s.app, "POST", "/v1/onboarding", await signedOnboard());
    const badOnUnbound = await expectError(await send(s.app, "PUT", "/v1/webhook", await signedWebhook("https://x.example.com/", stranger)), 401, "unauthenticated");
    const goodOnUnbound = await expectError(await send(s.app, "PUT", "/v1/webhook", await signedWebhook("https://x.example.com/")), 401, "unauthenticated");
    expect(badOnUnbound).toBe(badOnBound);
    expect(goodOnUnbound).toBe(badOnBound);
    expect(await s.count("customer_webhook")).toBe(1);
  });

  test("roles RPC down → 503 unavailable (retryable), nothing written", async () => {
    const { app, reader, count } = await bound();
    reader.rolesDown = true;
    await expectError(await send(app, "PUT", "/v1/webhook", await signedWebhook("https://x.example.com/")), 503, "unavailable", true);
    expect(await count("customer_webhook")).toBe(1);
  });
});
