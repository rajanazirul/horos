import { PGlite } from "@electric-sql/pglite";
import {
  buildSnapshotContent,
  decisionRecord,
  PostgresAccountStore,
  PostgresListStore,
  runMigrations,
  usedNonce,
  uuidv7,
  type HorosDb,
} from "@horos/adapters";
import type { ChainReader, ChainView, ListSnapshot, ProvisionedKeys, WalletRoles } from "@horos/core";
import {
  CHECK_TYPES,
  checkDomain,
  checkMessageFromRequest,
  CheckResponse,
  ErrorEnvelope,
  type CheckRequest,
  type Hex,
} from "@horos/schema";
import { drizzle } from "drizzle-orm/pglite";
import type { Context } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { DEFAULT_CHECK_RATE_PER_MINUTE, postgresCheckDeps } from "./check.js";
import { FixedWindowLimiter } from "./rate-limit.js";

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
const SDN_ADDR: Hex = "0xabcdefabcdefabcdefabcdefabcdefabcdef0001";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const EXPIRY = "2026-09-28T12:02:00.000Z";
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
  entries: new Map([[SDN_ADDR, ["EXAMPLE SANCTIONED ENTITY"]]]),
  lastVerifiedAt: NOW.getTime() - 60_000,
};

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

let template: Promise<Blob> | undefined;
/** Migrate and bind once per file; each test loads its database from the dump (far cheaper than migrating). */
function templateDump(): Promise<Blob> {
  template ??= (async () => {
    const client = new PGlite();
    const db = drizzle(client) as unknown as HorosDb;
    await runMigrations(db);
    const accounts = new PostgresAccountStore(db);
    const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: NOW });
    await accounts.setKeys(binding.customerId, KEYS, NOW);
    await accounts.bind(binding.customerId, WALLET, NOW);
    const dump = await client.dumpDataDir("none");
    await client.close();
    return dump;
  })();
  return template;
}

beforeAll(async () => {
  await templateDump();
});

interface SetupOptions {
  readonly checkRatePerMinute?: number;
  readonly mountCheck?: boolean;
  readonly trustedProxyHops?: number;
  readonly remoteAddress?: (c: Context) => string | undefined;
  /** Use the production default (`loadActiveListSnapshots` over the list store) instead of a fixed SDN list. */
  readonly storeLists?: boolean;
}

async function setup(opts: SetupOptions = {}) {
  const client = new PGlite({ loadDataDir: await templateDump() });
  clients.push(client);
  const db = drizzle(client) as unknown as HorosDb;
  const logs: Record<string, unknown>[] = [];
  const check = postgresCheckDeps(db, {
    chainReader: new FakeChain(),
    chainId: CHAIN_ID,
    now: () => NOW,
    ...(opts.storeLists === true ? {} : { lists: async () => [sdn] }),
    limitWriteWaitMs: 0,
    log: (e) => logs.push(e),
  });
  const app = createApp({
    policyVersions: { active: async () => undefined, insert: async () => {} },
    adminToken: TOKEN,
    now: () => NOW,
    newId: () => "unused",
    log: (e) => logs.push(e),
    ...(opts.mountCheck === false ? {} : { check }),
    ...(opts.checkRatePerMinute === undefined ? {} : { checkRatePerMinute: opts.checkRatePerMinute }),
    ...(opts.trustedProxyHops === undefined ? {} : { trustedProxyHops: opts.trustedProxyHops }),
    ...(opts.remoteAddress === undefined ? {} : { remoteAddress: opts.remoteAddress }),
  });
  const recordCount = async () => (await db.select().from(decisionRecord)).length;
  return { app, db, logs, recordCount };
}

let nonceSeq = 0;
const freshNonce = (): Hex => `0x${(++nonceSeq).toString(16).padStart(64, "0")}`;

async function signed(patch: Partial<CheckRequest> = {}, nonce: Hex = freshNonce()): Promise<CheckRequest> {
  const base: CheckRequest = {
    policy_wallet: WALLET,
    counterparty: PAYEE,
    amount: (50n * USDC).toString(),
    ...patch,
    auth: { nonce, expiry: EXPIRY, signature: `0x${"0".repeat(130)}` },
  };
  const signature = await payment.signTypedData({
    domain: checkDomain(CHAIN_ID, WALLET),
    types: CHECK_TYPES,
    primaryType: "Check",
    message: checkMessageFromRequest(base),
  });
  return { ...base, auth: { nonce, expiry: EXPIRY, signature } };
}

const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /v1/check", () => {
  test("is not mounted without check deps", async () => {
    const { app } = await setup({ mountCheck: false });
    const res = await post(app, {});
    expect(res.status).toBe(404);
    expect(ErrorEnvelope.parse(await res.json()).error.code).toBe("not_found");
  });

  test("a signed first-contact Check returns a valid enforced CheckResponse", async () => {
    const { app, db } = await setup();
    const res = await post(app, await signed());
    expect(res.status).toBe(200);
    const body = CheckResponse.parse(await res.json());
    expect(body).toMatchObject({ decision: "allow", advisory: false, chain_state: "live", limit_write: "pending", simulated: false });
    expect(await db.select().from(usedNonce)).toHaveLength(1);
  });

  test("an unsigned Check runs advisory-public without questions", async () => {
    const { app } = await setup();
    const res = await post(app, { policy_wallet: WALLET, counterparty: PAYEE, amount: "50000000" });
    expect(res.status).toBe(200);
    const body = CheckResponse.parse(await res.json());
    expect(body).toMatchObject({ advisory: true, limit_write: "none" });
    expect(body).not.toHaveProperty("questions");
  });

  test.each([
    ["not JSON", "{nope"],
    ["bad address", { policy_wallet: WALLET, counterparty: "0x1234", amount: "1" }],
    ["amount 0", { policy_wallet: WALLET, counterparty: PAYEE, amount: "0" }],
    ["identity over 1024 bytes", { policy_wallet: WALLET, counterparty: PAYEE, amount: "1", declared_identity: { purpose: "x".repeat(500), name: "y".repeat(200), business_type: "z".repeat(100), domain: `${"d".repeat(240)}.example` } }],
  ])("validation failure (%s): 400 validation_failed, nothing written, nonce still usable", async (_name, raw) => {
    const { app, db, recordCount, logs } = await setup();
    const nonce = freshNonce();
    const body = typeof raw === "string" ? raw : { ...raw, auth: { nonce, expiry: EXPIRY, signature: `0x${"1".repeat(130)}` } };
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(ErrorEnvelope.parse(await res.json()).error.code).toBe("validation_failed");
    expect(await recordCount()).toBe(0);
    expect(JSON.stringify(logs)).not.toContain("yyyy");
    const ok = CheckResponse.parse(await (await post(app, await signed({}, nonce))).json());
    expect(ok.advisory).toBe(false);
    expect(await db.select().from(usedNonce)).toHaveLength(1);
  });

  test("authenticated Checks are limited per Customer: over the limit → 429 rate_limited, nothing written", async () => {
    const { app, recordCount } = await setup({ checkRatePerMinute: 3 });
    const reqs = await Promise.all(Array.from({ length: 4 }, () => signed()));
    for (const r of reqs.slice(0, 3)) expect((await post(app, r)).status).toBe(200);
    // A different client IP does not help: the key is the Customer.
    const res = await post(app, reqs[3], { "x-forwarded-for": "198.51.100.200" });
    expect(res.status).toBe(429);
    const err = ErrorEnvelope.parse(await res.json()).error;
    expect(err).toMatchObject({ code: "rate_limited", retryable: true });
    // NOW is on a minute boundary: the window resets in 60 s.
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await recordCount()).toBe(3);
  });

  test("trustedProxyHops 0 (default): a spoofed x-forwarded-for is ignored; the socket address is the key", async () => {
    const { app, recordCount } = await setup({ checkRatePerMinute: 2, remoteAddress: () => "192.0.2.1" });
    const body = { policy_wallet: WALLET, counterparty: PAYEE, amount: "1" };
    expect((await post(app, body, { "x-forwarded-for": "203.0.113.1" })).status).toBe(200);
    expect((await post(app, body, { "x-forwarded-for": "203.0.113.2" })).status).toBe(200);
    expect((await post(app, body, { "x-forwarded-for": "203.0.113.3" })).status).toBe(429);
    expect(await recordCount()).toBe(2);
  });

  test("trustedProxyHops 1: the right-most x-forwarded-for hop is the key", async () => {
    const { app, recordCount } = await setup({ checkRatePerMinute: 2, trustedProxyHops: 1, remoteAddress: () => "10.0.0.254" });
    const body = { policy_wallet: WALLET, counterparty: PAYEE, amount: "1" };
    // The client controls everything left of the hop our proxy appended.
    expect((await post(app, body, { "x-forwarded-for": "1.1.1.1, 203.0.113.7" })).status).toBe(200);
    expect((await post(app, body, { "x-forwarded-for": "2.2.2.2, 203.0.113.7" })).status).toBe(200);
    expect((await post(app, body, { "x-forwarded-for": "3.3.3.3, 203.0.113.7" })).status).toBe(429);
    expect((await post(app, body, { "x-forwarded-for": "3.3.3.3, 198.51.100.9" })).status).toBe(200);
    expect(await recordCount()).toBe(3);
  });

  test("header-less clients with different socket addresses are limited separately", async () => {
    const { app, recordCount } = await setup({ checkRatePerMinute: 1, remoteAddress: (c) => c.req.header("x-test-socket") });
    const body = { policy_wallet: WALLET, counterparty: PAYEE, amount: "1" };
    expect((await post(app, body, { "x-test-socket": "192.0.2.1" })).status).toBe(200);
    expect((await post(app, body, { "x-test-socket": "192.0.2.2" })).status).toBe(200);
    expect((await post(app, body, { "x-test-socket": "192.0.2.1" })).status).toBe(429);
    expect(await recordCount()).toBe(2);
  });

  test("the production default lists (active snapshots in the list store) block a listed address", async () => {
    const { app, db } = await setup({ storeLists: true });
    const store = new PostgresListStore(db);
    await store.activate(
      { id: uuidv7(NOW.getTime()), source: "ofac-sdn", content: buildSnapshotContent(new Map([[SDN_ADDR, ["EXAMPLE SANCTIONED ENTITY"]]])), fetchedAt: NOW },
      { now: new Date(NOW.getTime() - 60_000), lastModified: null },
    );
    const res = CheckResponse.parse(await (await post(app, await signed({ counterparty: SDN_ADDR }))).json());
    expect(res).toMatchObject({ decision: "block", advisory: false });
    const clean = CheckResponse.parse(await (await post(app, await signed())).json());
    expect(clean.decision).toBe("allow");
  });

  test("latency: 200 signed Checks, p95 < 500 ms (limit_write wait excluded)", async () => {
    const { app } = await setup({ checkRatePerMinute: 10_000 });
    const reqs = await Promise.all(Array.from({ length: 200 }, () => signed()));
    const times: number[] = [];
    for (const r of reqs) {
      const t0 = performance.now();
      const res = await post(app, r);
      times.push(performance.now() - t0);
      expect(res.status).toBe(200);
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Infinity;
    expect(p95).toBeLessThan(500);
  }, 180_000);
});

describe("FixedWindowLimiter", () => {
  test("default: the 121st Check from one key within a minute is refused", () => {
    const l = new FixedWindowLimiter(DEFAULT_CHECK_RATE_PER_MINUTE);
    const t0 = Date.parse("2026-09-28T12:00:00.000Z");
    const results = Array.from({ length: 121 }, (_, i) => l.take("customer:c1", t0 + i * 100));
    expect(results.slice(0, 120).every(Boolean)).toBe(true);
    expect(results[120]).toBe(false);
    expect(l.take("customer:c2", t0 + 12_100)).toBe(true);
    expect(l.take("customer:c1", t0 + 60_000)).toBe(true);
  });

  test("allows `limit` per key per window and resets on the next window", () => {
    const l = new FixedWindowLimiter(2, 1000);
    expect([l.take("a", 0), l.take("a", 10), l.take("a", 20), l.take("b", 30)]).toEqual([true, true, false, true]);
    expect(l.take("a", 1000)).toBe(true);
  });

  test("msUntilReset: time left in the current window (the Retry-After basis)", () => {
    const l = new FixedWindowLimiter(2, 60_000);
    expect(l.msUntilReset(0)).toBe(60_000);
    expect(l.msUntilReset(59_001)).toBe(999);
    expect(l.msUntilReset(120_500)).toBe(59_500);
  });

  test("caps tracked keys: a new key beyond maxKeys is refused, known keys still count, and the next window resets", () => {
    const l = new FixedWindowLimiter(5, 1000, 3);
    expect(["a", "b", "c"].map((k) => l.take(k, 0))).toEqual([true, true, true]);
    expect(l.take("d", 1)).toBe(false);
    expect(l.take("a", 2)).toBe(true);
    expect(l.size).toBe(3);
    expect(l.take("d", 1000)).toBe(true);
    expect(l.size).toBe(1);
  });

  test("rejects a non-positive limit", () => {
    expect(() => new FixedWindowLimiter(0)).toThrow(RangeError);
  });
});
