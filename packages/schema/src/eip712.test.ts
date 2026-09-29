import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { ZodError } from "zod";
import {
  CHECK_PRIMARY_TYPE,
  CHECK_TYPES,
  checkDomain,
  checkMessageFromRequest,
  CheckRequest,
  declaredIdentityHash,
  HUMAN_PRIMARY_TYPE,
  HUMAN_TYPES,
  humanDomain,
  MAX_CHECK_EXPIRY_SECONDS,
  wireTimeToUnixSeconds,
  ZERO_BYTES32,
  type HumanActionMessage,
} from "./index.js";

// Well-known Foundry/Anvil test key #0. Test-only; never funded on any real network.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CHAIN_ID = 5042002;
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CP = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";

function typeString(types: Record<string, readonly { name: string; type: string }[]>, primary: string): string {
  const fields = types[primary] ?? [];
  return `${primary}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

describe("EIP-712", () => {
  test("domains", () => {
    expect(checkDomain(CHAIN_ID, "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED")).toEqual({
      name: "Horos Check",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: WALLET,
    });
    expect(humanDomain(CHAIN_ID, WALLET).name).toBe("Horos Human");
    expect(() => checkDomain(0, WALLET)).toThrow(RangeError);
    expect(() => checkDomain(CHAIN_ID, "0x1234")).toThrow();
    expect(MAX_CHECK_EXPIRY_SECONDS).toBe(300);
  });

  test("type strings match the spine", () => {
    expect(typeString(CHECK_TYPES, CHECK_PRIMARY_TYPE)).toBe(
      "Check(address policyWallet,address counterparty,uint256 amount,bytes32 declaredIdentityHash,bytes32 nonce,uint64 expiry)",
    );
    expect(typeString(HUMAN_TYPES, HUMAN_PRIMARY_TYPE)).toBe(
      "HumanAction(address policyWallet,address counterparty,string kind,uint256 newLimit,string reviewedRecordId,bytes32 evidenceVectorHash,bytes32 reasonHash,bytes32 nonce,uint64 expiry)",
    );
  });

  test("a Check signed by viem recovers to the signer", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const declared_identity = { name: "Acme Data Labs", purpose: "API credits" };
    const unsigned = {
      policy_wallet: WALLET,
      counterparty: CP,
      amount: "2500000",
      declared_identity,
      auth: { nonce: `0x${"5a".repeat(32)}`, expiry: "2026-09-28T12:05:00.000Z", signature: `0x${"00".repeat(65)}` },
    };
    const message = checkMessageFromRequest(CheckRequest.parse(unsigned));
    expect(message).toEqual({
      policyWallet: WALLET,
      counterparty: CP,
      amount: 2_500_000n,
      declaredIdentityHash: declaredIdentityHash(declared_identity),
      nonce: `0x${"5a".repeat(32)}`,
      expiry: BigInt(Date.UTC(2026, 8, 28, 12, 5) / 1000),
    });

    const domain = checkDomain(CHAIN_ID, WALLET);
    const signature = await account.signTypedData({ domain, types: CHECK_TYPES, primaryType: "Check", message });
    const req = CheckRequest.parse({ ...unsigned, auth: { ...unsigned.auth, signature } });
    const recovered = await recoverTypedDataAddress({
      domain,
      types: CHECK_TYPES,
      primaryType: "Check",
      message: checkMessageFromRequest(req),
      signature: req.auth?.signature ?? "0x",
    });
    expect(recovered).toBe(account.address);

    // A different domain (Human) or tampered amount must not recover the signer.
    const otherDomain = await recoverTypedDataAddress({
      domain: humanDomain(CHAIN_ID, WALLET),
      types: CHECK_TYPES,
      primaryType: "Check",
      message,
      signature,
    });
    expect(otherDomain).not.toBe(account.address);
    const tampered = await recoverTypedDataAddress({
      domain,
      types: CHECK_TYPES,
      primaryType: "Check",
      message: { ...message, amount: 2_500_001n },
      signature,
    });
    expect(tampered).not.toBe(account.address);
  });

  test("a Check without declared identity signs ZERO_BYTES32", () => {
    const req = CheckRequest.parse({
      policy_wallet: WALLET,
      counterparty: CP,
      amount: "1",
      auth: { nonce: ZERO_BYTES32, expiry: "2026-09-28T12:05:00.000Z", signature: `0x${"00".repeat(65)}` },
    });
    expect(checkMessageFromRequest(req).declaredIdentityHash).toBe(ZERO_BYTES32);
  });

  test("checkMessageFromRequest requires auth and whole-second expiry", () => {
    expect(() => checkMessageFromRequest(CheckRequest.parse({ policy_wallet: WALLET, counterparty: CP, amount: "1" }))).toThrow(TypeError);
    expect(() => wireTimeToUnixSeconds("2026-09-28T12:05:00.001Z")).toThrow(RangeError);
    expect(wireTimeToUnixSeconds("1970-01-01T00:00:00.000Z")).toBe(0n);
  });

  test("wireTimeToUnixSeconds validates input and rejects pre-epoch times", () => {
    expect(() => wireTimeToUnixSeconds("1969-12-31T23:59:59.000Z")).toThrow(RangeError);
    expect(() => wireTimeToUnixSeconds("2026-09-28T12:05:00Z")).toThrow(ZodError);
    expect(() => wireTimeToUnixSeconds("Sep 28 2026")).toThrow(ZodError);
  });

  test("a HumanAction hashes and recovers with viem", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const domain = humanDomain(CHAIN_ID, WALLET);
    const message: HumanActionMessage = {
      policyWallet: WALLET,
      counterparty: CP,
      kind: "acknowledge",
      newLimit: 0n,
      reviewedRecordId: "01926f3a-8000-7000-8000-000000000003",
      evidenceVectorHash: `0x${"ee".repeat(32)}`,
      reasonHash: ZERO_BYTES32,
      nonce: `0x${"01".repeat(32)}`,
      expiry: 1_790_000_000n,
    };
    const hash = hashTypedData({ domain, types: HUMAN_TYPES, primaryType: "HumanAction", message });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const signature = await account.signTypedData({ domain, types: HUMAN_TYPES, primaryType: "HumanAction", message });
    expect(await recoverTypedDataAddress({ domain, types: HUMAN_TYPES, primaryType: "HumanAction", message, signature })).toBe(
      account.address,
    );
  });
});
