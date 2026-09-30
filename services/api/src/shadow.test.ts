// Story 3.4 api integration: Shadow Mode sign-up, the API-key Check, `shadow_closed`, the summary read and enforced
// isolation, in process against a real test Postgres with a counting fake chain.
import { seededTemplate, type DbTemplate, type TestClient } from "@horos/adapters/testing";
import { decisionRecord, outboxIntent, PostgresAccountStore, PostgresReadStore, PostgresShadowStore, shadowKeyHash, usedNonce } from "@horos/adapters";
import type { ChainReader, ChainView, ListSnapshot, ProvisionedKeys, WalletRoles } from "@horos/core";
import {
  ShadowCheckResponse,
  accountDomain,
  CHECK_TYPES,
  checkDomain,
  checkMessageFromRequest,
  CheckResponse,
  SHADOW_SIGNUP_TYPES,
  ShadowSignupResponse,
  toWireTime,
  type CheckRequest,
  type Hex,
} from "@horos/schema";
import { createHoros, fromViemAccount, shadowSignup, type FetchLike } from "@horos/sdk";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { postgresCheckDeps } from "./check.js";

const TOKEN = "test-admin-token-not-a-secret";
const CHAIN_ID = 5042002;
// Well-known Foundry/Anvil dev keys. Test-only; never funded on any real network.
const enforcedPayment = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const shadowPayment = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const PAY = enforcedPayment.address.toLowerCase() as Hex;
const SHADOW_PAY = shadowPayment.address.toLowerCase() as Hex;
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const SHADOW_WALLET: Hex = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const HUMAN: Hex = "0x3b60ebece31658efda2ad1cd28860cabbf2e4e85";
const PAYEE: Hex = "0x1111111111111111111111111111111111111111";
const SDN: Hex = "0xabcdefabcdefabcdefabcdefabcdefabcdef0001";
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-r", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-m", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-u", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};
const NOW = new Date("2026-09-28T12:00:00.000Z");
const USDC = 1_000_000n;
const u = (n: number) => (BigInt(n) * USDC).toString();

/** Counts every chain read by method. */
class FakeChain implements ChainReader {
  calls: string[] = [];
  roleMap: WalletRoles = { payment: PAY, registrar: KEYS.registrar.address, model: KEYS.model.address, rules: KEYS.rules.address, human: HUMAN };
  async remaining(): Promise<ChainView> {
    this.calls.push("remaining");
    return { cpRemaining: 0n, walletRemaining: 5_000n * USDC, newPayeeRemaining: 10n, limit: 0n, pinned: false, registered: false, humanSet: false, humanEpoch: 0n };
  }
  async roles(wallet: Hex) {
    this.calls.push("roles");
    return wallet === SHADOW_WALLET ? { ...this.roleMap, payment: SHADOW_PAY } : this.roleMap;
  }
  async policy() {
    this.calls.push("policy");
    return { firstContactCeiling: 500n * USDC, walletPeriodCap: 5_000n * USDC, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n };
  }
  async hasCode() {
    this.calls.push("hasCode");
    return false;
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

const sdn: ListSnapshot = {
  source: "ofac-sdn",
  snapshotId: "sdn-test",
  snapshotHash: `0x${"a".repeat(64)}`,
  entries: new Map([[SDN, ["EXAMPLE SANCTIONED ENTITY"]]]),
  lastVerifiedAt: NOW.getTime() - 60_000,
};

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

let template: Promise<DbTemplate> | undefined;
function boundTemplate(): Promise<DbTemplate> {
  template ??= seededTemplate(async (db) => {
    const accounts = new PostgresAccountStore(db);
    const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: NOW });
    await accounts.setKeys(binding.customerId, KEYS, NOW);
    await accounts.bind(binding.customerId, WALLET, NOW);
  });
  return template;
}

beforeAll(async () => {
  await boundTemplate();
});

afterAll(async () => {
  await (await template)?.drop();
});

async function setup(opts: { checkRatePerMinute?: number; publicDemoScope?: string; shadowIpRatePerMinute?: number } = {}) {
  const { client, db } = await (await boundTemplate()).fresh();
  clients.push(client);
  const chain = new FakeChain();
  const accounts = new PostgresAccountStore(db);
  const shadow = new PostgresShadowStore(db);
  const logs: Record<string, unknown>[] = [];
  const check = postgresCheckDeps(db, { chainReader: chain, chainId: CHAIN_ID, now: () => NOW, lists: async () => [sdn], limitWriteWaitMs: 0, ledger: shadow });
  const app = createApp({
    policyVersions: { active: async () => undefined, insert: async () => {} },
    adminToken: TOKEN,
    now: () => NOW,
    newId: () => "unused",
    check,
    reads: new PostgresReadStore(db),
    accounts,
    chainReader: chain,
    chainId: CHAIN_ID,
    shadow,
    ...(opts.publicDemoScope === undefined ? {} : { publicDemoScope: opts.publicDemoScope }),
    ...(opts.checkRatePerMinute === undefined ? {} : { checkRatePerMinute: opts.checkRatePerMinute }),
    ...(opts.shadowIpRatePerMinute === undefined ? {} : { shadowIpRatePerMinute: opts.shadowIpRatePerMinute }),
    remoteAddress: (c) => c.req.header("x-test-remote"),
    log: (e) => logs.push(e),
    logError: (e) => logs.push(e),
  });
  return { app, db, client, chain, accounts, shadow, logs, check };
}
type Setup = Awaited<ReturnType<typeof setup>>;

let nonceSeq = 0;
const freshNonce = (): Hex => `0x${(++nonceSeq).toString(16).padStart(64, "0")}`;
const expiryIn = (s: number) => toWireTime(new Date(NOW.getTime() + s * 1000));

async function signupBody(o: { signer?: typeof shadowPayment; address?: Hex; expiry?: string; nonce?: Hex } = {}) {
  const address = o.address ?? SHADOW_PAY;
  const nonce = o.nonce ?? freshNonce();
  const expiry = o.expiry ?? expiryIn(120);
  const signature = await (o.signer ?? shadowPayment).signTypedData({
    domain: accountDomain(CHAIN_ID),
    types: SHADOW_SIGNUP_TYPES,
    primaryType: "ShadowSignup",
    message: { paymentAddress: address, nonce, expiry: BigInt(Date.parse(expiry) / 1000) },
  });
  return { payment_address: address, auth: { nonce, expiry, signature } };
}

const post = (s: Setup, path: string, body: unknown, headers: Record<string, string> = {}) =>
  s.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function signUp(s: Setup) {
  const res = await post(s, "/v1/shadow", await signupBody());
  expect(res.status).toBe(200);
  return ShadowSignupResponse.parse(await res.json());
}

const shadowCheck = (s: Setup, apiKey: string | undefined, body: unknown = { counterparty: PAYEE, amount: u(50) }) =>
  post(s, "/v1/shadow/check", body, apiKey === undefined ? {} : { "x-horos-api-key": apiKey });

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function bindShadowCustomer(s: Setup, customerId: string) {
  await s.accounts.onboard({ paymentAddress: SHADOW_PAY, webhookUrl: "", now: NOW });
  await s.accounts.setKeys(customerId, KEYS, NOW);
  await s.accounts.bind(customerId, SHADOW_WALLET, NOW);
}

const ledgerRows = async (s: Setup) =>
  Number(
    (await s.client.query<{ n: string }>(`SELECT (SELECT count(*) FROM shadow_ledger_counterparty) + (SELECT count(*) FROM shadow_ledger_slot) AS n`)).rows[0]?.n,
  );

describe("POST /v1/shadow", () => {
  test("a Payment-signed sign-up returns the Customer, its shadow Scope and a key shown once; only its hash is stored", async () => {
    const s = await setup();
    const res = await post(s, "/v1/shadow", await signupBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = ShadowSignupResponse.parse(await res.json());
    expect(body.scope).toBe(`shadow:${body.customerId}`);
    const stored = await s.client.query<{ key_hash: string }>(`SELECT key_hash FROM shadow_api_key`);
    expect(stored.rows).toEqual([{ key_hash: shadowKeyHash(body.apiKey) }]);
    expect(JSON.stringify(s.logs)).not.toContain(body.apiKey);
  });

  test("a repeat sign-up issues a new key; the old key is refused (401)", async () => {
    const s = await setup();
    const first = await signUp(s);
    const second = await signUp(s);
    expect(second.customerId).toBe(first.customerId);
    expect(second.apiKey).not.toBe(first.apiKey);
    const old = await shadowCheck(s, first.apiKey);
    expect(old.status).toBe(401);
    expect(await errorCode(old)).toBe("unauthenticated");
    expect((await shadowCheck(s, second.apiKey)).status).toBe(200);
  });

  test("bad signature, wrong signer, expired, over-long expiry and a replayed nonce: 401, nothing issued", async () => {
    const s = await setup();
    const bad = await signupBody();
    const cases = [
      { ...bad, auth: { ...bad.auth, signature: `0x${"11".repeat(65)}` } },
      await signupBody({ signer: other }),
      await signupBody({ expiry: expiryIn(-1) }),
      await signupBody({ expiry: expiryIn(301) }),
      { payment_address: SHADOW_PAY },
    ];
    for (const body of cases) {
      const res = await post(s, "/v1/shadow", body);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("unauthenticated");
    }
    expect(await s.db.$count(decisionRecord)).toBe(0);
    expect((await s.client.query(`SELECT 1 FROM shadow_api_key`)).rows).toHaveLength(0);
    // A replayed envelope: the first use issues, the second is refused.
    const once = await signupBody();
    expect((await post(s, "/v1/shadow", once)).status).toBe(200);
    const replay = await post(s, "/v1/shadow", once);
    expect(replay.status).toBe(401);
    expect((await s.client.query(`SELECT 1 FROM shadow_api_key`)).rows).toHaveLength(1);
  });

  test("the admin bearer may sign up any address; a wrong bearer is 401; a malformed body is 400", async () => {
    const s = await setup();
    const admin = await post(s, "/v1/shadow", { payment_address: SHADOW_PAY }, { authorization: `Bearer ${TOKEN}` });
    expect(admin.status).toBe(200);
    const wrong = await post(s, "/v1/shadow", { payment_address: SHADOW_PAY }, { authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
    expect((await post(s, "/v1/shadow", "not json")).status).toBe(400);
    expect(await errorCode(await post(s, "/v1/shadow", { payment_address: "0x12" }))).toBe("validation_failed");
  });

  test("after the Customer's PolicyWallet is bound: 410 shadow_closed, nothing issued", async () => {
    const s = await setup();
    const first = await signUp(s);
    await bindShadowCustomer(s, first.customerId);
    const res = await post(s, "/v1/shadow", await signupBody());
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: { code: "shadow_closed", retryable: false } });
    expect((await s.client.query(`SELECT 1 FROM shadow_api_key`)).rows).toHaveLength(1);
    // The enforced Customer (already bound) is closed too.
    const enforced = await post(s, "/v1/shadow", { payment_address: PAY }, { authorization: `Bearer ${TOKEN}` });
    expect(enforced.status).toBe(410);
  });
});

describe("POST /v1/shadow/check", () => {
  test("first contact 50 USDC: allow, advisory, limit_write none, no tx_hash; no outbox row or nonce; only hasCode read", async () => {
    const s = await setup();
    const { apiKey, scope } = await signUp(s);
    const res = await shadowCheck(s, apiKey);
    expect(res.status).toBe(200);
    const body = ShadowCheckResponse.parse(await res.json());
    expect(body).toMatchObject({ decision: "allow", advisory: true, limit_write: "none", chain_state: "live", simulated: false, outcome: "advisory" });
    expect(body.tx_hash).toBeUndefined();
    expect(s.chain.calls).toEqual(["hasCode"]);
    expect(await s.db.$count(outboxIntent)).toBe(0);
    expect(await s.db.$count(usedNonce)).toBe(0);
    const recs = await s.db.select().from(decisionRecord).where(eq(decisionRecord.scope, scope));
    expect(recs.map((r) => (r.record as { advisory: boolean }).advisory)).toEqual([true]);
    expect(await s.shadow.remaining(scope, PAYEE, NOW)).toMatchObject({ registered: true, walletRemaining: 4_950n * USDC, newPayeeRemaining: 9n });
    // Shadow output never speaks of gating or catching.
    expect(JSON.stringify(body)).not.toMatch(/gated|caught/i);
  });

  test("spend accumulates across Checks exactly as the truth table decides for the virtual view", async () => {
    const s = await setup();
    const { apiKey } = await signUp(s);
    const decide = async (amount: number) => CheckResponse.parse(await (await shadowCheck(s, apiKey, { counterparty: PAYEE, amount: u(amount) })).json());
    expect(await decide(50)).toMatchObject({ decision: "allow", effective_limit: u(100) });
    expect(await decide(40)).toMatchObject({ decision: "allow" });
    expect(await decide(30)).toMatchObject({ decision: "cap", payable_amount: u(10) });
    expect(await decide(5)).toMatchObject({ decision: "cap", payable_amount: "0" });
  });

  test("a sanctioned counterparty blocks and the summary counts it would-have-caught", async () => {
    const s = await setup();
    const { apiKey, scope } = await signUp(s);
    expect(CheckResponse.parse(await (await shadowCheck(s, apiKey)).json()).decision).toBe("allow");
    const blocked = ShadowCheckResponse.parse(await (await shadowCheck(s, apiKey, { counterparty: SDN, amount: u(1) })).json());
    expect(blocked).toMatchObject({ decision: "block", simulated: false, advisory: true, outcome: "would-have-caught" });
    const summary = await s.app.request(`/v1/scopes/${scope}/shadow-summary`, { headers: { "x-horos-api-key": apiKey } });
    expect(summary.status).toBe(200);
    expect(summary.headers.get("cache-control")).toBe("no-store");
    expect(await summary.json()).toEqual({ advisory: 1, would_have_caught: 1 });
    // The shadow records are readable with the same key (resolveShadowKey is wired from the shadow store).
    const records = await s.app.request(`/v1/scopes/${scope}/records`, { headers: { "x-horos-api-key": apiKey } });
    expect(((await records.json()) as { records: unknown[] }).records).toHaveLength(2);
  });

  test("missing, unknown or malformed key: 401 and no record; an invalid body with a valid key: 400", async () => {
    const s = await setup();
    const { apiKey } = await signUp(s);
    for (const key of [undefined, "", "hsk_nope", `hsk_${"A".repeat(43)}`]) {
      const res = await shadowCheck(s, key);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("unauthenticated");
    }
    const bad = await shadowCheck(s, apiKey, { counterparty: PAYEE, amount: "0" });
    expect(bad.status).toBe(400);
    const withWallet = await shadowCheck(s, apiKey, { policy_wallet: WALLET, counterparty: PAYEE, amount: u(1) });
    expect(withWallet.status).toBe(400);
    expect(await s.db.$count(decisionRecord)).toBe(0);
  });

  test("after bind: 410 shadow_closed and no record", async () => {
    const s = await setup();
    const { apiKey, customerId } = await signUp(s);
    await bindShadowCustomer(s, customerId);
    const res = await shadowCheck(s, apiKey);
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("shadow_closed");
    expect(await s.db.$count(decisionRecord)).toBe(0);
  });

  test("rate limited per shadow Customer: 429 with Retry-After, nothing written", async () => {
    const s = await setup({ checkRatePerMinute: 2 });
    const { apiKey, scope } = await signUp(s);
    expect((await shadowCheck(s, apiKey)).status).toBe(200);
    expect((await shadowCheck(s, apiKey)).status).toBe(200);
    const limited = await shadowCheck(s, apiKey);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await s.db.$count(decisionRecord, eq(decisionRecord.scope, scope))).toBe(2);
  });
});

describe("per-IP rate limits", () => {
  test("sign-up attempts are limited per client IP (429 with Retry-After); another IP is unaffected", async () => {
    const s = await setup({ shadowIpRatePerMinute: 2 });
    const from = (ip: string) => ({ "x-test-remote": ip });
    expect((await post(s, "/v1/shadow", await signupBody(), from("10.0.0.1"))).status).toBe(200);
    expect((await post(s, "/v1/shadow", { payment_address: "0x12" }, from("10.0.0.1"))).status).toBe(400);
    const limited = await post(s, "/v1/shadow", await signupBody(), from("10.0.0.1"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await errorCode(limited)).toBe("rate_limited");
    expect((await post(s, "/v1/shadow", await signupBody(), from("10.0.0.2"))).status).toBe(200);
    expect((await s.client.query(`SELECT 1 FROM shadow_api_key`)).rows).toHaveLength(2);
  });

  test("failed API keys are limited per client IP before any lookup; a valid key from another IP still works", async () => {
    const s = await setup({ shadowIpRatePerMinute: 2 });
    const { apiKey } = await signUp(s);
    const guess = (ip: string, key: string) => post(s, "/v1/shadow/check", { counterparty: PAYEE, amount: u(1) }, { "x-horos-api-key": key, "x-test-remote": ip });
    expect((await guess("10.0.0.9", `hsk_${"A".repeat(43)}`)).status).toBe(401);
    expect((await guess("10.0.0.9", `hsk_${"B".repeat(43)}`)).status).toBe(401);
    // Budget spent: even the valid key is refused from this IP (no oracle), with nothing written.
    const refused = await guess("10.0.0.9", apiKey);
    expect(refused.status).toBe(429);
    expect(await s.db.$count(decisionRecord)).toBe(0);
    expect((await guess("10.0.0.10", apiKey)).status).toBe(200);
  });
});

describe("summary access", () => {
  test("another Customer's key is 403, no key is 401, and a non-shadow Scope has no summary (404)", async () => {
    const s = await setup({ publicDemoScope: "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80" });
    const { scope } = await signUp(s);
    const otherKey = await post(s, "/v1/shadow", { payment_address: other.address.toLowerCase() }, { authorization: `Bearer ${TOKEN}` });
    const { apiKey: foreign } = ShadowSignupResponse.parse(await otherKey.json());
    expect((await s.app.request(`/v1/scopes/${scope}/shadow-summary`, { headers: { "x-horos-api-key": foreign } })).status).toBe(403);
    expect((await s.app.request(`/v1/scopes/${scope}/shadow-summary`)).status).toBe(401);
    const demo = await s.app.request(`/v1/scopes/enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80/shadow-summary`);
    expect(demo.status).toBe(404);
    expect((await s.app.request(`/v1/scopes/${scope}/shadow-summary`, { method: "POST" })).status).toBe(405);
  });
});

describe("enforced isolation", () => {
  async function signedCheck(counterparty: Hex, wallet: Hex = WALLET, signer = enforcedPayment): Promise<CheckRequest> {
    const unsigned: CheckRequest = {
      policy_wallet: wallet,
      counterparty,
      amount: u(50),
      auth: { nonce: freshNonce(), expiry: expiryIn(120), signature: `0x${"0".repeat(130)}` },
    };
    const signature = await signer.signTypedData({
      domain: checkDomain(CHAIN_ID, wallet),
      types: CHECK_TYPES,
      primaryType: "Check",
      message: checkMessageFromRequest(unsigned),
    });
    return { ...unsigned, auth: { ...(unsigned.auth as NonNullable<CheckRequest["auth"]>), signature: signature.toLowerCase() as Hex } };
  }

  test("after shadow activity, an enforced Check reads the chain only; the ledger tables are untouched", async () => {
    const s = await setup();
    const { apiKey } = await signUp(s);
    expect((await shadowCheck(s, apiKey)).status).toBe(200);
    const before = await ledgerRows(s);
    expect(before).toBeGreaterThan(0);
    s.chain.calls = [];
    const res = await post(s, "/v1/check", await signedCheck(PAYEE));
    const body = CheckResponse.parse(await res.json());
    expect(body).toMatchObject({ advisory: false, limit_write: "pending" });
    expect(s.chain.calls).toEqual(expect.arrayContaining(["remaining", "policy", "hasCode", "roles"]));
    expect(await ledgerRows(s)).toBe(before);
  });

  test("the same Customer, once bound: shadow is closed, its enforced Checks are enforced and never touch the ledger", async () => {
    const s = await setup();
    const { apiKey, customerId } = await signUp(s);
    expect((await shadowCheck(s, apiKey)).status).toBe(200);
    await bindShadowCustomer(s, customerId);
    const before = await ledgerRows(s);
    // The enforced path gets a ledger that throws on any access.
    const trap = new Proxy(s.shadow, {
      get(_target, prop) {
        throw new Error(`enforced Check touched the ledger (${String(prop)})`);
      },
    });
    const enforcedApp = createApp({
      policyVersions: { active: async () => undefined, insert: async () => {} },
      adminToken: TOKEN,
      now: () => NOW,
      newId: () => "unused",
      check: { ...s.check, ledger: trap },
      chainId: CHAIN_ID,
    });
    const res = await enforcedApp.request("/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await signedCheck(PAYEE, SHADOW_WALLET, shadowPayment)),
    });
    const body = CheckResponse.parse(await res.json());
    expect(body).toMatchObject({ advisory: false, limit_write: "pending" });
    expect(await ledgerRows(s)).toBe(before);
    expect((await shadowCheck(s, apiKey)).status).toBe(410);
  });
});

describe("@horos/sdk Shadow Mode against the api", () => {
  test("shadowSignup then createHoros({apiKey}): advisory Checks, the shadow log and the summary", async () => {
    const s = await setup();
    const fetch: FetchLike = async (url, init) =>
      await s.app.request(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    const now = () => NOW.getTime();
    const signup = await shadowSignup({ baseUrl: "http://horos.test", chainId: CHAIN_ID, signer: fromViemAccount(shadowPayment), fetch, now });
    expect(signup.scope).toBe(`shadow:${signup.customerId}`);
    const horos = createHoros({ baseUrl: "http://horos.test", chainId: CHAIN_ID, apiKey: signup.apiKey, scope: signup.scope, fetch, now });
    expect(await horos.check({ counterparty: PAYEE, amount: 50n * USDC })).toMatchObject({ decision: "allow", advisory: true, limit_write: "none" });
    expect(await horos.check({ counterparty: SDN, amount: USDC })).toMatchObject({ decision: "block", advisory: true, outcome: "would-have-caught" });
    expect((await horos.listRecords()).records).toHaveLength(2);
    expect(await horos.getShadowSummary()).toEqual({ advisory: 1, would_have_caught: 1 });
    expect(await s.db.$count(outboxIntent)).toBe(0);
  });
});
