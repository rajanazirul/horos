import { accountDomain, CHECK_PRIMARY_TYPE, CHECK_TYPES, checkDomain, type Hex } from "@horos/schema";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { circleDcwSigner, circleTypedDataJson, fromViemAccount, type CircleDcwClient, type SignableTypedData } from "./signer.js";

// Well-known Foundry/Anvil dev key. Test-only; never funded on any real network.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";

const check: SignableTypedData = {
  domain: checkDomain(5042002, WALLET),
  types: CHECK_TYPES,
  primaryType: CHECK_PRIMARY_TYPE,
  message: {
    policyWallet: WALLET,
    counterparty: "0x1111111111111111111111111111111111111111",
    amount: 12_345_678n,
    declaredIdentityHash: `0x${"0".repeat(64)}`,
    nonce: `0x${"ab".repeat(32)}`,
    expiry: 1_790_000_000n,
  },
};
const human = { ...check, domain: { ...check.domain, name: "Horos Human" } } as unknown as SignableTypedData;

/** A fake Circle client that signs the JSON it is given with the test key (as Circle would with the EOA's key). */
function fakeCircle(): CircleDcwClient & { calls: { walletId: string; data: string }[] } {
  const calls: { walletId: string; data: string }[] = [];
  return {
    calls,
    async signTypedData(input) {
      calls.push(input);
      const td = JSON.parse(input.data) as {
        types: Record<string, { name: string; type: string }[]>;
        domain: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const types = { ...td.types };
      delete types.EIP712Domain;
      const fields = types[td.primaryType] ?? [];
      const message = Object.fromEntries(Object.entries(td.message).map(([k, v]) => [k, fields.find((f) => f.name === k)?.type.startsWith("uint") ? BigInt(v as string) : v]));
      const signature = await account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message } as never);
      return { data: { signature } };
    },
  };
}

describe("fromViemAccount", () => {
  test("signs Checks that recover to the account", async () => {
    const signer = fromViemAccount(account);
    expect(signer.address).toBe(account.address.toLowerCase());
    const signature = await signer.signTypedData(check);
    expect((await recoverTypedDataAddress({ ...check, signature } as never)).toLowerCase()).toBe(signer.address);
  });

  test("refuses the Horos Human domain (AD-12)", async () => {
    await expect(fromViemAccount(account).signTypedData(human)).rejects.toThrow(/refusing to sign/);
  });
});

describe("circleDcwSigner", () => {
  test("sends Circle an EIP-712 JSON with EIP712Domain and bigints as strings; the signature recovers", async () => {
    const client = fakeCircle();
    const signer = circleDcwSigner({ client, walletId: "w-pay", address: account.address });
    const signature = await signer.signTypedData(check);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.walletId).toBe("w-pay");
    const sent = JSON.parse(client.calls[0]?.data ?? "{}");
    expect(sent.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(sent.message.amount).toBe("12345678");
    expect(sent.primaryType).toBe("Check");
    expect((await recoverTypedDataAddress({ ...check, signature } as never)).toLowerCase()).toBe(signer.address);
  });

  test("the account domain has no verifyingContract field", () => {
    const json = JSON.parse(circleTypedDataJson({ domain: accountDomain(5042002), types: { ReadAccess: [] }, primaryType: "ReadAccess", message: {} }));
    expect(json.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(["name", "version", "chainId"]);
  });

  test("refuses the Horos Human domain without calling Circle", async () => {
    const client = fakeCircle();
    await expect(circleDcwSigner({ client, walletId: "w", address: account.address }).signTypedData(human)).rejects.toThrow(/refusing to sign/);
    expect(client.calls).toHaveLength(0);
  });

  test("a missing or malformed signature from Circle is an error", async () => {
    const client: CircleDcwClient = { signTypedData: async () => ({ data: {} }) };
    await expect(circleDcwSigner({ client, walletId: "w", address: account.address }).signTypedData(check)).rejects.toThrow(/65-byte/);
  });

  test("rejects a malformed address or empty wallet id", () => {
    expect(() => circleDcwSigner({ client: fakeCircle(), walletId: "w", address: "0x12" })).toThrow();
    expect(() => circleDcwSigner({ client: fakeCircle(), walletId: "", address: account.address })).toThrow();
  });
});
