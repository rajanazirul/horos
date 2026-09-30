// Story 3.1 integration: the `@horos/sdk` client against the in-process api (fetch adapter over `app.request`).
// Proves the retry rule end to end: a retryable failure before the record append consumes no nonce, so the SDK's
// byte-identical resend is accepted as enforced, while the same envelope sent again after success is a replay and
// comes back advisory.
import { seededTemplate, type DbTemplate, type TestClient } from "@horos/adapters/testing";
import { PostgresAccountStore, PostgresReadStore, usedNonce } from "@horos/adapters";
import type { ChainReader, ChainView, ListSnapshot, ProvisionedKeys, WalletRoles } from "@horos/core";
import { CheckResponse, type Hex } from "@horos/schema";
import { createHoros, fromViemAccount, type FetchLike } from "@horos/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { postgresCheckDeps } from "./check.js";

const TOKEN = "test-admin-token-not-a-secret";
const CHAIN_ID = 5042002;
// Well-known Foundry/Anvil dev key. Test-only; never funded on any real network.
const payment = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const PAY = payment.address.toLowerCase() as Hex;
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const HUMAN: Hex = "0x3b60ebece31658efda2ad1cd28860cabbf2e4e85";
const PAYEE: Hex = "0x1111111111111111111111111111111111111111";
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-r", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-m", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-u", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};
const NOW = new Date("2026-09-28T12:00:00.000Z");
const USDC = 1_000_000n;

class FakeChain implements ChainReader {
  roleMap: WalletRoles = { payment: PAY, registrar: KEYS.registrar.address, model: KEYS.model.address, rules: KEYS.rules.address, human: HUMAN };
  async remaining(): Promise<ChainView> {
    return { cpRemaining: 0n, walletRemaining: 5_000n * USDC, newPayeeRemaining: 10n, limit: 0n, pinned: false, registered: false, humanSet: false, humanEpoch: 0n };
  }
  async roles() {
    return this.roleMap;
  }
  async policy() {
    return { firstContactCeiling: 500n * USDC, walletPeriodCap: 5_000n * USDC, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n };
  }
  async hasCode() {
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
  entries: new Map([["0xabcdefabcdefabcdefabcdefabcdefabcdef0001", ["EXAMPLE SANCTIONED ENTITY"]]]),
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

/** The api in process, with a list source that fails the first `failures` Checks (before any record append). */
async function setup(failures = 0) {
  const { client, db } = await (await boundTemplate()).fresh();
  clients.push(client);
  let toFail = failures;
  const chain = new FakeChain();
  const accounts = new PostgresAccountStore(db);
  const check = postgresCheckDeps(db, {
    chainReader: chain,
    chainId: CHAIN_ID,
    now: () => NOW,
    lists: async () => {
      if (toFail > 0) {
        toFail--;
        throw new Error("list store unavailable");
      }
      return [sdn];
    },
    limitWriteWaitMs: 0,
  });
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
    logError: () => {},
  });
  const sent: { url: string; status: number; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const res = await app.request(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    sent.push({ url, status: res.status, ...(init.body === undefined ? {} : { body: init.body }) });
    return res;
  };
  const scope = (await accounts.bindingByWallet(WALLET))?.scopeId;
  const sleeps: number[] = [];
  // The SDK's clock advances with its sleeps, so a retry-loop bug fails at the envelope deadline instead of hanging.
  let clock = NOW.getTime();
  const horos = createHoros({
    baseUrl: "http://horos.test",
    chainId: CHAIN_ID,
    policyWallet: WALLET,
    signer: fromViemAccount(payment),
    ...(scope === undefined ? {} : { scope }),
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { app, db, horos, sent, sleeps };
}

describe("@horos/sdk against the api", () => {
  test("a signed Check is enforced and its record is readable with the SDK's ReadAccess", async () => {
    const { horos, sent } = await setup();
    const res = await horos.check({ counterparty: PAYEE, amount: 50n * USDC, declaredIdentity: { name: "Acme Test Supplies" } });
    expect(res).toMatchObject({ decision: "allow", advisory: false, chain_state: "live", limit_write: "pending" });
    expect(sent).toHaveLength(1);
    const detail = await horos.getRecord(res.record_id);
    expect(detail.record.id).toBe(res.record_id);
    expect(detail.recordHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a retryable no-record failure is resent byte-identical and accepted as enforced; a later resend is a replay", async () => {
    const { app, db, horos, sent, sleeps } = await setup(1);
    const res = await horos.check({ counterparty: PAYEE, amount: 50n * USDC });
    expect(sent.map((s) => s.status)).toEqual([500, 200]);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(sleeps).toEqual([250]);
    expect(res.advisory).toBe(false);
    expect(await db.select().from(usedNonce)).toHaveLength(1);

    // The same envelope once more: the nonce is spent, so the api runs it advisory-public (AD-11).
    const replay = await app.request("/v1/check", { method: "POST", headers: { "content-type": "application/json" }, body: sent[0]?.body ?? "" });
    expect(replay.status).toBe(200);
    expect(CheckResponse.parse(await replay.json())).toMatchObject({ advisory: true, limit_write: "none" });
    expect(await db.select().from(usedNonce)).toHaveLength(1);
  });
});
