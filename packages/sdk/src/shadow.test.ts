// Story 3.4: the SDK's Shadow Mode: `shadowSignup` (Payment-signed ShadowSignup) and `createHoros({apiKey})`.
import { accountDomain, errorEnvelope, SHADOW_SIGNUP_TYPES, ShadowSignupRequest, type Hex, type ShadowCheckResponse } from "@horos/schema";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { createHoros, type FetchLike } from "./client.js";
import { HorosError } from "./errors.js";
import { shadowSignup } from "./shadow.js";
import { fromViemAccount } from "./signer.js";

// Well-known Foundry/Anvil dev key. Test-only; never funded on any real network.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const CHAIN_ID = 5042002;
const PAYEE: Hex = "0x1111111111111111111111111111111111111111";
const CUSTOMER = "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00";
const SCOPE = `shadow:${CUSTOMER}`;
const KEY = `hsk_${"k".repeat(43)}`;
const T0 = Date.parse("2026-09-28T12:00:00.300Z");

const shadowOk: ShadowCheckResponse = {
  decision: "allow",
  effective_limit: "100000000",
  remaining: "50000000",
  reason: "within the limit",
  confidence: 1,
  record_id: "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f01",
  simulated: false,
  advisory: true,
  limit_write: "none",
  chain_state: "live",
  outcome: "advisory",
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(replies: (Response | Error)[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  let clock = T0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    const r = replies[calls.length - 1];
    if (r === undefined) throw new Error("no reply queued");
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetch, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
}

async function rejection(p: Promise<unknown>): Promise<HorosError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HorosError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

describe("shadowSignup", () => {
  test("signs a ShadowSignup with the Payment key, posts it, and returns the key", async () => {
    const r = recorder([json(200, { customerId: CUSTOMER, scope: SCOPE, apiKey: KEY })]);
    const res = await shadowSignup({ baseUrl: "https://api.horos.test/", chainId: CHAIN_ID, signer: fromViemAccount(account), ...r });
    expect(res).toEqual({ customerId: CUSTOMER, scope: SCOPE, apiKey: KEY });
    expect(r.calls[0]?.url).toBe("https://api.horos.test/v1/shadow");
    const body = ShadowSignupRequest.parse(JSON.parse(r.calls[0]?.body ?? "null"));
    expect(body.payment_address).toBe(account.address.toLowerCase());
    const auth = body.auth;
    if (auth === undefined) throw new Error("no auth");
    expect(Date.parse(auth.expiry) - T0).toBeLessThanOrEqual(120_000);
    const signer = await recoverTypedDataAddress({
      domain: accountDomain(CHAIN_ID),
      types: SHADOW_SIGNUP_TYPES,
      primaryType: "ShadowSignup",
      message: { paymentAddress: body.payment_address, nonce: auth.nonce, expiry: BigInt(Date.parse(auth.expiry) / 1000) },
      signature: auth.signature,
    });
    expect(signer.toLowerCase()).toBe(account.address.toLowerCase());
  });

  test("shadow_closed is a non-retryable HorosError", async () => {
    const r = recorder([json(410, errorEnvelope("shadow_closed", "closed"))]);
    const err = await rejection(shadowSignup({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, signer: fromViemAccount(account), ...r }));
    expect(err).toMatchObject({ code: "shadow_closed", retryable: false, status: 410 });
    expect(r.calls).toHaveLength(1);
  });

  test("a retryable failure resends the same bytes", async () => {
    const r = recorder([json(503, errorEnvelope("unavailable", "down")), json(200, { customerId: CUSTOMER, scope: SCOPE, apiKey: KEY })]);
    await shadowSignup({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, signer: fromViemAccount(account), ...r });
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]?.body).toBe(r.calls[0]?.body);
  });

  test("a transport failure is not retried: the sign-up may have succeeded", async () => {
    const r = recorder([new TypeError("fetch failed"), json(200, { customerId: CUSTOMER, scope: SCOPE, apiKey: KEY })]);
    const err = await rejection(shadowSignup({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, signer: fromViemAccount(account), ...r }));
    expect(err).toMatchObject({ code: "unavailable", retryable: false });
    expect(err.message).toContain("the previous sign-up may have succeeded; sign up again to get a fresh key");
    expect(r.calls).toHaveLength(1);
  });

  test("a non-JSON answer is not retried either", async () => {
    const r = recorder([new Response("<html>bad gateway</html>", { status: 502 })]);
    const err = await rejection(shadowSignup({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, signer: fromViemAccount(account), ...r }));
    expect(err).toMatchObject({ code: "unavailable", retryable: false, status: 502 });
    expect(r.calls).toHaveLength(1);
  });

  test("a replayed nonce (401 nonce already used) maps to the sign-up-again message", async () => {
    const r = recorder([json(401, errorEnvelope("unauthenticated", "nonce already used"))]);
    const err = await rejection(shadowSignup({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, signer: fromViemAccount(account), ...r }));
    expect(err).toMatchObject({ code: "unauthenticated", retryable: false, status: 401 });
    expect(err.message).toContain("the previous sign-up may have succeeded; sign up again to get a fresh key");
  });

  test("bad options fail before any request", async () => {
    const r = recorder([]);
    await expect(shadowSignup({ baseUrl: "nope", chainId: CHAIN_ID, signer: fromViemAccount(account), ...r })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(shadowSignup({ baseUrl: "https://a.test", chainId: 0, signer: fromViemAccount(account), ...r })).rejects.toMatchObject({ code: "validation_failed" });
    expect(r.calls).toHaveLength(0);
  });
});

describe("createHoros({apiKey})", () => {
  test("check() posts to /v1/shadow/check with the key header and no wallet, nonce or signature", async () => {
    const r = recorder([json(200, shadowOk)]);
    const horos = createHoros({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, apiKey: KEY, ...r });
    expect(horos).toMatchObject({ signed: false, shadow: true, address: undefined });
    const res = await horos.check({ counterparty: PAYEE, amount: 50_000_000n, declaredIdentity: { name: "Acme" } });
    expect(res).toEqual(shadowOk);
    expect(res.outcome).toBe("advisory");
    expect(r.calls[0]?.url).toBe("https://api.horos.test/v1/shadow/check");
    expect(r.calls[0]?.headers["x-horos-api-key"]).toBe(KEY);
    expect(JSON.parse(r.calls[0]?.body ?? "null")).toEqual({ counterparty: PAYEE, amount: "50000000", declared_identity: { name: "Acme" } });
  });

  test("a shadow Check without its outcome label does not parse (non-retryable, not resent)", async () => {
    const { outcome: _omit, ...plain } = shadowOk;
    void _omit;
    const r = recorder([json(200, plain), json(200, shadowOk)]);
    const horos = createHoros({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, apiKey: KEY, ...r });
    expect(await rejection(horos.check({ counterparty: PAYEE, amount: 1n }))).toMatchObject({ code: "unavailable", retryable: false });
    expect(r.calls).toHaveLength(1);
  });

  test("a retryable error envelope (sent before any write) is retried with the same body", async () => {
    const r = recorder([json(503, errorEnvelope("unavailable", "down")), json(429, errorEnvelope("rate_limited", "slow down")), json(200, shadowOk)]);
    const horos = createHoros({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, apiKey: KEY, ...r });
    expect(await horos.check({ counterparty: PAYEE, amount: 1n })).toEqual(shadowOk);
    expect(r.calls).toHaveLength(3);
    expect(new Set(r.calls.map((c) => c.body)).size).toBe(1);
  });

  test.each([
    ["a network failure", () => new TypeError("fetch failed")],
    ["a timeout", () => Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["a non-JSON 502", () => new Response("bad gateway", { status: 502 })],
    ["a non-envelope 500", () => json(500, { oops: true })],
  ])("%s is not retried: the Check may or may not have been recorded", async (_name, reply) => {
    const r = recorder([reply(), json(200, shadowOk)]);
    const horos = createHoros({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, apiKey: KEY, ...r });
    const err = await rejection(horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "unavailable", retryable: false });
    expect(err.message).toContain("may or may not have been recorded");
    expect(r.calls).toHaveLength(1);
  });

  test("reads and the summary send the key instead of a ReadAccess", async () => {
    const r = recorder([json(200, { records: [], nextCursor: null }), json(200, { advisory: 3, would_have_caught: 1 })]);
    const horos = createHoros({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, apiKey: KEY, scope: SCOPE, ...r });
    await horos.listRecords();
    expect(await horos.getShadowSummary()).toEqual({ advisory: 3, would_have_caught: 1 });
    expect(r.calls.map((c) => c.url)).toEqual([
      `https://api.horos.test/v1/scopes/${encodeURIComponent(SCOPE)}/records`,
      `https://api.horos.test/v1/scopes/${encodeURIComponent(SCOPE)}/shadow-summary`,
    ]);
    for (const c of r.calls) {
      expect(c.headers["x-horos-api-key"]).toBe(KEY);
      expect(c.headers["x-horos-signature"]).toBeUndefined();
    }
  });

  test("shadow_closed from the api surfaces as a non-retryable HorosError", async () => {
    const r = recorder([json(410, errorEnvelope("shadow_closed", "closed"))]);
    const horos = createHoros({ baseUrl: "https://api.horos.test", chainId: CHAIN_ID, apiKey: KEY, ...r });
    const err = await rejection(horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "shadow_closed", retryable: false });
    expect(r.calls).toHaveLength(1);
  });

  test("apiKey with a signer, or a malformed key, is refused without echoing the key", () => {
    expect(() => createHoros({ baseUrl: "https://a.test", chainId: CHAIN_ID, apiKey: KEY, signer: fromViemAccount(account), policyWallet: PAYEE })).toThrow(
      /exclusive/,
    );
    try {
      createHoros({ baseUrl: "https://a.test", chainId: CHAIN_ID, apiKey: "hsk_secret-but-short" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HorosError);
      expect(String((err as Error).message)).not.toContain("secret-but-short");
    }
  });

  test("getShadowSummary needs a shadow Scope", async () => {
    const horos = createHoros({ baseUrl: "https://a.test", chainId: CHAIN_ID, apiKey: KEY, scope: "advisory-public" });
    await expect(horos.getShadowSummary()).rejects.toMatchObject({ code: "validation_failed" });
  });
});
