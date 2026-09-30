import { afterAll, expect, test } from "vitest";
import { apiKeyFromEnv, baseUrlFromEnv, ConfigError, HUMAN_KEY_REFUSED, NO_PAYMENT_KEY, parseHumanAddress, paymentAccountFromEnv, QuickstartError, randomAddress, rpcUrlFromEnv } from "./env.js";
import { API_KEY, HUMAN, KEY, KEY_ADDRESS, scanAndCleanTempRepos } from "./harness.test-helpers.js";

afterAll(scanAndCleanTempRepos);

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

test("--human: an address is accepted and lowercased", () => {
  expect(parseHumanAddress(" 0x3B60EBECE31658EFDA2AD1CD28860CABBF2E4E85 ")).toBe(HUMAN);
});

test("--human: a 32-byte hex value is refused with the custody explanation, never echoed", () => {
  for (const v of [KEY, KEY.slice(2), KEY.toUpperCase().replace("0X", "0x")]) {
    const e = errorOf(() => parseHumanAddress(v));
    expect(e).toBeInstanceOf(QuickstartError);
    expect(e.message).toBe(HUMAN_KEY_REFUSED);
    expect(e.message).toMatch(/custody/);
    expect(e.message.toLowerCase()).not.toContain(KEY.slice(2, 20));
  }
});

test("--human: a phrase or garbage is refused without echo", () => {
  const phrase = "test test test test test test test test test test test junk";
  expect(errorOf(() => parseHumanAddress(phrase)).message).not.toContain("junk");
  expect(errorOf(() => parseHumanAddress("0x1234zz")).message).not.toContain("1234zz");
  expect(errorOf(() => parseHumanAddress(undefined)).message).toMatch(/--human <address> is required/);
});

test("no Payment key: explains HOROS_PAYMENT_PRIVATE_KEY and the Circle path", () => {
  const e = errorOf(() => paymentAccountFromEnv({}));
  expect(e.message).toBe(NO_PAYMENT_KEY);
  expect(e.message).toMatch(/HOROS_PAYMENT_PRIVATE_KEY/);
  expect(e.message).toMatch(/Circle/);
});

test("Payment key: parsed from env; a malformed one names the variable only", () => {
  expect(paymentAccountFromEnv({ HOROS_PAYMENT_PRIVATE_KEY: KEY }).address.toLowerCase()).toBe(KEY_ADDRESS);
  const e = errorOf(() => paymentAccountFromEnv({ HOROS_PAYMENT_PRIVATE_KEY: "0x12345678" }));
  expect(e).toBeInstanceOf(ConfigError);
  expect(e.message).not.toContain("12345678");
});

test("base URL: required, https with a key unless loopback", () => {
  expect(() => baseUrlFromEnv({}, true)).toThrow(/HOROS_BASE_URL is required/);
  expect(() => baseUrlFromEnv({ HOROS_BASE_URL: "http://api.example.com" }, true)).toThrow(/https/);
  expect(baseUrlFromEnv({ HOROS_BASE_URL: "http://127.0.0.1:8080" }, true)).toBe("http://127.0.0.1:8080");
  expect(baseUrlFromEnv({ HOROS_BASE_URL: "https://api.example.com/" }, true)).toBe("https://api.example.com");
});

test("RPC URL: optional on Arc testnet, required elsewhere", () => {
  expect(rpcUrlFromEnv({}, 5042002)).toBeUndefined();
  expect(() => rpcUrlFromEnv({}, 31337)).toThrow(/HOROS_RPC_URL/);
});

test("API key: from env, shape-checked, never echoed", () => {
  expect(apiKeyFromEnv({ HOROS_API_KEY: API_KEY })).toBe(API_KEY);
  expect(errorOf(() => apiKeyFromEnv({ HOROS_API_KEY: "nope-secret" })).message).not.toContain("nope-secret");
  expect(() => apiKeyFromEnv({})).toThrow(/HOROS_API_KEY is not set/);
});

test("random known-good address: fresh each time", () => {
  const a = randomAddress();
  expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  expect(randomAddress()).not.toBe(a);
});

test("--human: a key with a 0X prefix, quotes or punctuation gets the custody message too", () => {
  for (const v of [`0X${KEY.slice(2).toUpperCase()}`, `"${KEY}"`, `${KEY},`, `(${KEY.slice(2)}).`, `${KEY.slice(2, 34)} ${KEY.slice(34)}`]) {
    const e = errorOf(() => parseHumanAddress(v));
    expect(e.message, v).toBe(HUMAN_KEY_REFUSED);
    expect(e.message).toMatch(/treat it as exposed/);
  }
});

test("base URL: a path, query or credentials are refused, not truncated", () => {
  expect(() => baseUrlFromEnv({ HOROS_BASE_URL: "https://api.example.com/horos" }, true)).toThrow(/origin only/);
  expect(() => baseUrlFromEnv({ HOROS_BASE_URL: "https://api.example.com/?x=1" }, true)).toThrow(/origin only/);
  expect(() => baseUrlFromEnv({ HOROS_BASE_URL: "https://u:p@api.example.com" }, true)).toThrow(/origin only/);
});
