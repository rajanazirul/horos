import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import {
  accountDomain,
  API_KEY_HEADER,
  SHADOW_SIGNUP_PRIMARY_TYPE,
  SHADOW_SIGNUP_TYPES,
  ShadowApiKey,
  ShadowCheckRequest,
  ShadowCheckResponse,
  shadowSignupMessageFromRequest,
  ShadowSignupRequest,
  ShadowSignupResponse,
  ShadowSummary,
} from "./index.js";

// Well-known Foundry/Anvil test key #0. Test-only; never funded on any real network.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CHAIN_ID = 5042002;
const CUSTOMER = "01926f3a-7b2c-7d4e-8f00-0123456789ab";
const KEY = `hsk_${"A".repeat(40)}_-9`;
const auth = { nonce: `0x${"5a".repeat(32)}`, expiry: "2026-09-28T12:05:00.000Z", signature: `0x${"00".repeat(65)}` };

describe("ShadowSignup (Horos Account domain)", () => {
  test("type string", () => {
    const fields = SHADOW_SIGNUP_TYPES[SHADOW_SIGNUP_PRIMARY_TYPE];
    expect(`${SHADOW_SIGNUP_PRIMARY_TYPE}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`).toBe(
      "ShadowSignup(address paymentAddress,bytes32 nonce,uint64 expiry)",
    );
  });

  test("a ShadowSignup signed by viem recovers to the payment address", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const req = ShadowSignupRequest.parse({ payment_address: account.address, auth });
    const message = shadowSignupMessageFromRequest(req);
    expect(message).toEqual({ paymentAddress: account.address.toLowerCase(), nonce: auth.nonce, expiry: BigInt(Date.UTC(2026, 8, 28, 12, 5) / 1000) });
    const domain = accountDomain(CHAIN_ID);
    const signature = await account.signTypedData({ domain, types: SHADOW_SIGNUP_TYPES, primaryType: "ShadowSignup", message });
    expect(await recoverTypedDataAddress({ domain, types: SHADOW_SIGNUP_TYPES, primaryType: "ShadowSignup", message, signature })).toBe(account.address);
  });

  test("the message builder refuses a request without auth", () => {
    const req = ShadowSignupRequest.parse({ payment_address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" });
    expect(() => shadowSignupMessageFromRequest(req)).toThrow(TypeError);
  });

  test("the request is strict", () => {
    expect(ShadowSignupRequest.safeParse({ payment_address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", extra: 1 }).success).toBe(false);
    expect(ShadowSignupRequest.safeParse({ payment_address: "0x12" }).success).toBe(false);
  });
});

describe("shadow wire types", () => {
  test("API key format", () => {
    expect(API_KEY_HEADER).toBe("x-horos-api-key");
    expect(ShadowApiKey.safeParse(KEY).success).toBe(true);
    expect(ShadowApiKey.safeParse(`hsk_${"A".repeat(42)}`).success).toBe(false);
    expect(ShadowApiKey.safeParse(`sk_${"A".repeat(43)}`).success).toBe(false);
    expect(ShadowApiKey.safeParse(`hsk_${"A".repeat(42)}=`).success).toBe(false);
  });

  test("the sign-up response carries a shadow Scope only", () => {
    expect(ShadowSignupResponse.safeParse({ customerId: CUSTOMER, scope: `shadow:${CUSTOMER}`, apiKey: KEY }).success).toBe(true);
    expect(ShadowSignupResponse.safeParse({ customerId: CUSTOMER, scope: `enforced:${CUSTOMER}`, apiKey: KEY }).success).toBe(false);
  });

  test("a shadow Check has no policy_wallet and no auth", () => {
    const base = { counterparty: "0x1111111111111111111111111111111111111111", amount: "50000000" };
    expect(ShadowCheckRequest.parse(base)).toEqual(base);
    expect(ShadowCheckRequest.safeParse({ ...base, policy_wallet: base.counterparty }).success).toBe(false);
    expect(ShadowCheckRequest.safeParse({ ...base, auth }).success).toBe(false);
    expect(ShadowCheckRequest.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(ShadowCheckRequest.safeParse({ ...base, declared_identity: { name: "Acme" } }).success).toBe(true);
  });

  test("the summary has exactly the two labels", () => {
    expect(ShadowSummary.parse({ advisory: 3, would_have_caught: 1 })).toEqual({ advisory: 3, would_have_caught: 1 });
    expect(ShadowSummary.safeParse({ advisory: 3, would_have_caught: 1, caught: 1 }).success).toBe(false);
    expect(ShadowSummary.safeParse({ advisory: -1, would_have_caught: 0 }).success).toBe(false);
  });

  test("a shadow Check response is a CheckResponse plus its outcome label", () => {
    const base = {
      decision: "block",
      effective_limit: "0",
      remaining: "0",
      reason: "listed",
      confidence: 1,
      record_id: "01926f3a-7b2c-7d4e-8f00-0123456789ab",
      simulated: false,
      advisory: true,
      limit_write: "none",
      chain_state: "live",
    };
    expect(ShadowCheckResponse.parse({ ...base, outcome: "would-have-caught" })).toMatchObject({ outcome: "would-have-caught", decision: "block" });
    expect(ShadowCheckResponse.safeParse(base).success).toBe(false);
    expect(ShadowCheckResponse.safeParse({ ...base, outcome: "caught" }).success).toBe(false);
    expect(ShadowCheckResponse.safeParse({ ...base, decision: "cap", outcome: "advisory" }).success).toBe(false);
  });
});
