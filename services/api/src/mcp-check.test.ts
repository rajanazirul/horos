// Story 3.3 integration: an MCP client calls `check` on the `@horos/mcp` server, which drives the `@horos/sdk` client
// against the in-process api (fetch adapter over `app.request`). A signed first contact is enforced and leaves a
// register intent in the outbox (the Check writes); an unsigned call is advisory and writes nothing.
import { seededTemplate, type DbTemplate, type TestClient } from "@horos/adapters/testing";
import { outboxIntent, PostgresAccountStore, PostgresReadStore, usedNonce } from "@horos/adapters";
import type { ChainReader, ChainView, ListSnapshot, ProvisionedKeys, WalletRoles } from "@horos/core";
import type { Hex } from "@horos/schema";
import { createHorosMcpServer } from "@horos/mcp";
import { createHoros, fromViemAccount, type FetchLike, type HorosOptions } from "@horos/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

const SANCTIONED: Hex = "0xabcdefabcdefabcdefabcdefabcdefabcdef0001";
const sdn: ListSnapshot = {
  source: "ofac-sdn",
  snapshotId: "sdn-test",
  snapshotHash: `0x${"a".repeat(64)}`,
  entries: new Map([[SANCTIONED, ["EXAMPLE SANCTIONED ENTITY"]]]),
  lastVerifiedAt: NOW.getTime() - 60_000,
};

const clients: TestClient[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
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
async function setup(signed: boolean, failures = 0) {
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
  const options: HorosOptions = {
    baseUrl: "http://horos.test",
    chainId: CHAIN_ID,
    ...(signed ? { policyWallet: WALLET, signer: fromViemAccount(payment) } : {}),
    ...(scope === undefined ? {} : { scope }),
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  const server = createHorosMcpServer({ client: createHoros(options) });
  const mcp = new Client({ name: "api-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  closers.push(async () => {
    await mcp.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => (await mcp.callTool({ name, arguments: args })) as CallToolResult;
  return { app, db, call, sent, sleeps, scope };
}

describe("@horos/mcp check against the api", () => {
  test("signed first contact: mode enforced, limit_write pending, and a register intent in the outbox", async () => {
    const { db, call, sent, scope } = await setup(true);
    const r = await call("check", { counterparty: PAYEE, amount: (50n * USDC).toString(), declared_identity: { name: "Acme Test Supplies" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ decision: "allow", advisory: false, mode: "enforced", limit_write: "pending", chain_state: "live" });
    for (const k of ["decision", "effective_limit", "remaining", "reason", "confidence", "record_id", "simulated", "advisory", "limit_write", "chain_state"]) {
      expect(r.structuredContent).toHaveProperty(k);
    }
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toHaveProperty("auth");
    const intents = await db.select().from(outboxIntent);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ status: "pending", laneRole: "registrar", scope, counterparty: PAYEE, createdByRecord: (r.structuredContent as { record_id: string }).record_id });

    // The record is readable through the read-only log tool with the signed ReadAccess.
    const rec = await call("get_decision_record", { record_id: (r.structuredContent as { record_id: string }).record_id });
    expect(rec.isError).toBeFalsy();
    expect(rec.structuredContent).toHaveProperty("recordHash");
  });

  test("signed, first attempt fails retryably: the SDK's resend is accepted, enforced, with exactly one used nonce", async () => {
    const { db, call, sent, sleeps } = await setup(true, 1);
    const r = await call("check", { counterparty: PAYEE, amount: (50n * USDC).toString() });
    expect(r.isError).toBeFalsy();
    expect(sent.map((x) => x.status)).toEqual([500, 200]);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(sleeps).toEqual([250]);
    expect(r.structuredContent).toMatchObject({ mode: "enforced", advisory: false });
    expect(await db.select().from(usedNonce)).toHaveLength(1);
  });

  test("signed Check of a sanctioned counterparty: block through MCP, and no register intent", async () => {
    const { db, call } = await setup(true);
    const r = await call("check", { counterparty: SANCTIONED, amount: (5n * USDC).toString() });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ decision: "block", mode: "enforced", advisory: false });
    const intents = await db.select().from(outboxIntent);
    expect(intents.filter((i) => i.laneRole === "registrar")).toHaveLength(0);
  });

  test("unsigned: the api receives no auth, answers advisory, and nothing is queued", async () => {
    const { db, call, sent } = await setup(false);
    const r = await call("check", { counterparty: PAYEE, amount: (50n * USDC).toString() });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ mode: "advisory", advisory: true, limit_write: "none" });
    expect(JSON.parse(sent[0]?.body ?? "{}")).not.toHaveProperty("auth");
    expect(await db.select().from(outboxIntent)).toHaveLength(0);
  });
});
