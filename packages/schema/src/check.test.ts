import { getAddress, keccak256, stringToBytes } from "viem";
import { describe, expect, test } from "vitest";
import { ZodError } from "zod";
import {
  ADVISORY_PUBLIC_CUSTOMER_ID,
  CheckRequest,
  CheckResponse,
  DeclaredIdentity,
  declaredIdentityHash,
  errorEnvelope,
  jcs,
  utf8ByteLength,
  UuidV7,
  ZERO_BYTES32,
} from "./index.js";

const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CP = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";

/** Map a failed parse to the wire error the api would return. */
function toWireError(input: unknown) {
  const r = CheckRequest.safeParse(input);
  return r.success ? null : errorEnvelope("validation_failed", r.error.issues[0]?.message ?? "invalid");
}

describe("CheckRequest", () => {
  test("valid request with EIP-55 addresses parses and lowercases", () => {
    const req = CheckRequest.parse({ policy_wallet: getAddress(WALLET), counterparty: getAddress(CP), amount: "2500000" });
    expect(req).toEqual({ policy_wallet: WALLET, counterparty: CP, amount: "2500000" });
  });

  test("bad checksum → validation_failed", () => {
    const bad = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(toWireError({ policy_wallet: WALLET, counterparty: bad, amount: "1" })).toEqual({
      error: { code: "validation_failed", retryable: false, message: expect.any(String) as string },
    });
  });

  test.each<unknown>([2.5, 2500000, "2.5", "-1", "0", "", "1e6"])("amount %j → validation_failed", (amount) => {
    expect(toWireError({ policy_wallet: WALLET, counterparty: CP, amount })?.error.code).toBe("validation_failed");
  });

  test("unknown keys are rejected", () => {
    expect(CheckRequest.safeParse({ policy_wallet: WALLET, counterparty: CP, amount: "1", extra: 1 }).success).toBe(false);
  });

  test.each([
    ["non-whole-second expiry", "2026-09-28T12:05:00.001Z"],
    ["pre-1970 expiry", "1969-12-31T23:59:59.000Z"],
  ])("auth rejects %s → validation_failed", (_label, expiry) => {
    const auth = { nonce: `0x${"aa".repeat(32)}`, expiry, signature: `0x${"11".repeat(65)}` };
    expect(toWireError({ policy_wallet: WALLET, counterparty: CP, amount: "1", auth })?.error.code).toBe("validation_failed");
  });

  test("auth accepts the unix epoch", () => {
    const auth = { nonce: `0x${"aa".repeat(32)}`, expiry: "1970-01-01T00:00:00.000Z", signature: `0x${"11".repeat(65)}` };
    expect(CheckRequest.safeParse({ policy_wallet: WALLET, counterparty: CP, amount: "1", auth }).success).toBe(true);
  });

  test("auth envelope", () => {
    const auth = { nonce: `0x${"AA".repeat(32)}`, expiry: "2026-09-28T12:05:00.000Z", signature: `0x${"11".repeat(65)}` };
    const req = CheckRequest.parse({ policy_wallet: WALLET, counterparty: CP, amount: "1", auth });
    expect(req.auth?.nonce).toBe(`0x${"aa".repeat(32)}`);
    expect(CheckRequest.safeParse({ policy_wallet: WALLET, counterparty: CP, amount: "1", auth: { ...auth, expiry: "soon" } }).success).toBe(false);
  });
});

describe("DeclaredIdentity", () => {
  test("accepts any non-empty subset of fields", () => {
    expect(DeclaredIdentity.parse({ name: "Acme" })).toEqual({ name: "Acme" });
  });

  test.each<[string, unknown]>([
    ["empty object", {}],
    ["unknown field", { name: "Acme", ssn: "x" }],
    ["name > 200", { name: "x".repeat(201) }],
    ["domain > 253", { domain: "x".repeat(254) }],
    ["business_type > 100", { business_type: "x".repeat(101) }],
    ["purpose > 500", { purpose: "x".repeat(501) }],
    ["null field", { name: null }],
    // All fields within limits, but JCS form > 1024 bytes (multi-byte characters).
    ["JCS > 1024 bytes", { name: "é".repeat(200), purpose: "é".repeat(400) }],
  ])("rejects %s", (_label, value) => {
    expect(DeclaredIdentity.safeParse(value).success).toBe(false);
    expect(
      toWireError({ policy_wallet: WALLET, counterparty: CP, amount: "1", declared_identity: value })?.error.code,
    ).toBe("validation_failed");
  });

  test("JCS size bound: exactly 1024 bytes accepted, 1025 rejected", () => {
    const make = (k: number) => ({ name: "a".repeat(200), domain: "b".repeat(253), business_type: "c".repeat(100), purpose: "d".repeat(k) });
    const k = 1024 - (utf8ByteLength(jcs(make(1))) - 1);
    expect(k).toBeGreaterThan(0);
    expect(k + 1).toBeLessThanOrEqual(500);
    expect(utf8ByteLength(jcs(make(k)))).toBe(1024);
    expect(DeclaredIdentity.safeParse(make(k)).success).toBe(true);
    expect(utf8ByteLength(jcs(make(k + 1)))).toBe(1025);
    expect(DeclaredIdentity.safeParse(make(k + 1)).success).toBe(false);
  });

  test("declaredIdentityHash is keccak of JCS, zero when absent", () => {
    expect(declaredIdentityHash()).toBe(ZERO_BYTES32);
    expect(declaredIdentityHash({ purpose: "API credits", name: "Acme" })).toBe(
      keccak256(stringToBytes('{"name":"Acme","purpose":"API credits"}')),
    );
    expect(() => declaredIdentityHash({})).toThrow(ZodError);
  });
});

describe("CheckResponse", () => {
  const base = {
    decision: "allow",
    effective_limit: "100000000",
    remaining: "97500000",
    reason: "Allowed: within the remaining limit.",
    confidence: 1,
    record_id: "01926f3a-8000-7000-8000-000000000001",
    simulated: false,
    advisory: false,
    limit_write: "none",
    chain_state: "live",
  } as const;

  test("valid allow", () => {
    expect(CheckResponse.parse(base)).toEqual(base);
  });

  test("cap requires payable_amount", () => {
    expect(CheckResponse.safeParse({ ...base, decision: "cap" }).success).toBe(false);
    expect(CheckResponse.safeParse({ ...base, decision: "cap", payable_amount: "0" }).success).toBe(true);
  });

  test("payable_amount only with cap", () => {
    expect(CheckResponse.safeParse({ ...base, payable_amount: "1" }).success).toBe(false);
  });

  test.each<[string, Record<string, unknown>]>([
    ["confidence > 1", { confidence: 1.01 }],
    ["confidence < 0", { confidence: -0.1 }],
    ["empty reason", { reason: "" }],
    ["reason > 600", { reason: "x".repeat(601) }],
    ["bad limit_write", { limit_write: "done" }],
    ["bad chain_state", { chain_state: "unknown" }],
    ["numeric amount", { remaining: 1 }],
  ])("rejects %s", (_label, patch) => {
    expect(CheckResponse.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  test("advisory responses carry no per-question confidence", () => {
    const questions = [{ id: "q-industry", answer: "low-risk", confidence: 0.9 }];
    expect(CheckResponse.safeParse({ ...base, advisory: true, questions }).success).toBe(false);
    expect(CheckResponse.safeParse({ ...base, advisory: true, questions: [{ id: "q-industry", answer: "low-risk" }] }).success).toBe(true);
    expect(CheckResponse.safeParse({ ...base, advisory: false, questions }).success).toBe(true);
  });

  test("optional judge, tx_hash, questions", () => {
    const full = {
      ...base,
      judge: "jev-1.13.0",
      tx_hash: `0x${"12".repeat(32)}`,
      questions: [{ id: "q-industry", answer: "low-risk", confidence: 0.9 }, { id: "q-name", answer: false }],
    };
    expect(CheckResponse.parse(full)).toEqual(full);
  });
});

describe("ADVISORY_PUBLIC_CUSTOMER_ID", () => {
  test("is the fixed, valid UUIDv7 system customer id", () => {
    expect(ADVISORY_PUBLIC_CUSTOMER_ID).toBe("00000000-0000-7000-8000-000000000000");
    expect(UuidV7.safeParse(ADVISORY_PUBLIC_CUSTOMER_ID).success).toBe(true);
  });
});
