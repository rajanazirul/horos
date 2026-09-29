import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import {
  accountDomain,
  accountExpiryValid,
  BIND_PRIMARY_TYPE,
  BIND_TYPES,
  bindMessageFromRequest,
  BindRequest,
  MAX_ACCOUNT_EXPIRY_SECONDS,
  ONBOARD_PRIMARY_TYPE,
  ONBOARD_TYPES,
  onboardMessageFromRequest,
  OnboardingRequest,
  redactUrl,
  redactUrls,
  WEBHOOK_UPDATE_PRIMARY_TYPE,
  WEBHOOK_UPDATE_TYPES,
  webhookUpdateMessageFromRequest,
  WebhookUpdateRequest,
  WebhookUrl,
} from "./index.js";

// Well-known Foundry/Anvil test key #0. Test-only; never funded on any real network.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CHAIN_ID = 5042002;
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

function typeString(types: Record<string, readonly { name: string; type: string }[]>, primary: string): string {
  const fields = types[primary] ?? [];
  return `${primary}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

const auth = { nonce: `0x${"5a".repeat(32)}`, expiry: "2026-09-28T12:05:00.000Z", signature: `0x${"00".repeat(65)}` };

describe("Horos Account EIP-712", () => {
  test("domain has no verifyingContract", () => {
    expect(accountDomain(CHAIN_ID)).toEqual({ name: "Horos Account", version: "1", chainId: CHAIN_ID });
    expect(() => accountDomain(0)).toThrow(RangeError);
    expect(MAX_ACCOUNT_EXPIRY_SECONDS).toBe(300);
  });

  test("type strings", () => {
    expect(typeString(ONBOARD_TYPES, ONBOARD_PRIMARY_TYPE)).toBe("Onboard(address paymentAddress,string webhookUrl,bytes32 nonce,uint64 expiry)");
    expect(typeString(BIND_TYPES, BIND_PRIMARY_TYPE)).toBe("Bind(address paymentAddress,address policyWallet,bytes32 nonce,uint64 expiry)");
    expect(typeString(WEBHOOK_UPDATE_TYPES, WEBHOOK_UPDATE_PRIMARY_TYPE)).toBe(
      "WebhookUpdate(address policyWallet,string webhookUrl,bytes32 nonce,uint64 expiry)",
    );
  });

  test("an Onboard signed by viem recovers to the payment address", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const req = OnboardingRequest.parse({ payment_address: account.address, webhook_url: "https://hooks.example.com/h?t=1", auth });
    const message = onboardMessageFromRequest(req);
    expect(message).toMatchObject({ paymentAddress: account.address.toLowerCase(), webhookUrl: "https://hooks.example.com/h?t=1" });
    expect(message.expiry).toBe(BigInt(Date.UTC(2026, 8, 28, 12, 5) / 1000));
    const domain = accountDomain(CHAIN_ID);
    const signature = await account.signTypedData({ domain, types: ONBOARD_TYPES, primaryType: "Onboard", message });
    expect(await recoverTypedDataAddress({ domain, types: ONBOARD_TYPES, primaryType: "Onboard", message, signature })).toBe(account.address);
    const other = await recoverTypedDataAddress({ domain: accountDomain(1), types: ONBOARD_TYPES, primaryType: "Onboard", message, signature });
    expect(other).not.toBe(account.address);
  });

  test("an Onboard without webhook signs the empty string", () => {
    const req = OnboardingRequest.parse({ payment_address: WALLET, auth });
    expect(onboardMessageFromRequest(req).webhookUrl).toBe("");
    expect(() => onboardMessageFromRequest(OnboardingRequest.parse({ payment_address: WALLET }))).toThrow(TypeError);
  });

  test("Bind and WebhookUpdate messages", () => {
    const b = bindMessageFromRequest(BindRequest.parse({ payment_address: WALLET, policy_wallet: WALLET, auth }));
    expect(b).toMatchObject({ paymentAddress: WALLET, policyWallet: WALLET });
    const w = webhookUpdateMessageFromRequest(WebhookUpdateRequest.parse({ policy_wallet: WALLET, webhook_url: "", auth }));
    expect(w).toMatchObject({ policyWallet: WALLET, webhookUrl: "" });
  });
});

describe("WebhookUrl", () => {
  test("accepts https and http://localhost; rejects the rest", () => {
    expect(WebhookUrl.safeParse("https://hooks.example.com/x").success).toBe(true);
    expect(WebhookUrl.safeParse("http://localhost:8787/x").success).toBe(true);
    expect(WebhookUrl.safeParse("http://hooks.example.com/x").success).toBe(false);
    expect(WebhookUrl.safeParse("https://user:pw@hooks.example.com/x").success).toBe(false);
    expect(WebhookUrl.safeParse("ftp://hooks.example.com/x").success).toBe(false);
    expect(WebhookUrl.safeParse("not a url").success).toBe(false);
    expect(WebhookUrl.safeParse(`https://a.example.com/${"x".repeat(2048)}`).success).toBe(false);
  });

  test("redactUrl keeps only origin + pathname", () => {
    expect(redactUrl("https://hooks.example.com/a/b?token=secret#frag")).toBe("https://hooks.example.com/a/b");
    expect(redactUrl("")).toBe("");
    expect(redactUrl("::")).toBe("(invalid url)");
    expect(redactUrls('HTTP request failed. URL: https://arc.example.com/v2/KEY123?x=1 body "x"; see http://localhost:8545/rpc')).toBe(
      'HTTP request failed. URL: https://arc.example.com body "x"; see http://localhost:8545',
    );
  });

  test("expiry must be in the future and within 300s", () => {
    const now = new Date("2026-09-28T12:00:00.000Z");
    expect(accountExpiryValid("2026-09-28T12:05:00.000Z", now)).toBe(true);
    expect(accountExpiryValid("2026-09-28T12:05:01.000Z", now)).toBe(false);
    expect(accountExpiryValid("2026-09-28T12:00:00.000Z", now)).toBe(false);
  });
});
