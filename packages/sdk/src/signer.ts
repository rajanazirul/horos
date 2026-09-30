// Payment-key signers for the SDK (AD-11, AD-15). Two kinds: a viem account, or a Circle developer-controlled
// wallet reached through a structural client (no Circle SDK dependency). Both refuse any EIP-712 domain other than
// "Horos Check" and "Horos Account": the SDK never signs a Human action (AD-12). No key is generated or stored here.
import type { Hex } from "@horos/schema";
import { getTypesForEIP712Domain, type LocalAccount } from "viem";

/** The only EIP-712 domains the SDK signs in: Checks and account read access. */
export const SIGNABLE_DOMAIN_NAMES = ["Horos Check", "Horos Account"] as const;
export type SignableDomainName = (typeof SIGNABLE_DOMAIN_NAMES)[number];

export interface SignableDomain {
  readonly name: SignableDomainName;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract?: Hex;
}

/** An EIP-712 payload the SDK asks its signer to sign. */
export interface SignableTypedData {
  readonly domain: SignableDomain;
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}

/** The Payment key, as the SDK sees it: an address and an EIP-712 signing function. */
export interface CheckSigner {
  /** The Payment role holder's address. */
  readonly address: Hex;
  /** Sign an EIP-712 payload; returns a 65-byte `r ‖ s ‖ v` signature. */
  signTypedData(typedData: SignableTypedData): Promise<Hex>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

function assertSignable(typedData: SignableTypedData): void {
  const name: string = typedData.domain.name;
  if (!(SIGNABLE_DOMAIN_NAMES as readonly string[]).includes(name)) {
    throw new TypeError(`refusing to sign in EIP-712 domain "${name}": the SDK signs only Horos Check and Horos Account payloads`);
  }
}

function lowerAddress(address: string): Hex {
  if (!ADDRESS_RE.test(address)) throw new TypeError("signer address must be 0x followed by 40 hex digits");
  return address.toLowerCase() as Hex;
}

function checkSignature(sig: unknown): Hex {
  if (typeof sig !== "string" || !SIGNATURE_RE.test(sig)) throw new TypeError("the signer did not return a 65-byte hex signature");
  return sig.toLowerCase() as Hex;
}

/** A signer over a viem local account (e.g. `privateKeyToAccount(...)`); the key stays inside the account. */
export function fromViemAccount(account: Pick<LocalAccount, "address" | "signTypedData">): CheckSigner {
  const address = lowerAddress(account.address);
  return {
    address,
    async signTypedData(typedData) {
      assertSignable(typedData);
      const sig = await account.signTypedData(typedData as unknown as Parameters<LocalAccount["signTypedData"]>[0]);
      return checkSignature(sig);
    },
  };
}

/**
 * The part of a Circle developer-controlled wallets client the SDK uses. The client returned by
 * `initiateDeveloperControlledWalletsClient` from `@circle-fin/developer-controlled-wallets` satisfies it.
 */
export interface CircleDcwClient {
  signTypedData(input: { walletId: string; data: string }): Promise<{ readonly data?: { readonly signature?: string } | undefined }>;
}

export interface CircleDcwSignerOptions {
  readonly client: CircleDcwClient;
  /** The Circle wallet id of the Payment EOA. */
  readonly walletId: string;
  /** The Payment EOA's address (the SDK checks every signature recovers to it). */
  readonly address: string;
}

/** JSON of an EIP-712 payload for Circle's signTypedData: bigints as decimal strings, `EIP712Domain` included. */
export function circleTypedDataJson(typedData: SignableTypedData): string {
  const payload = {
    types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }), ...typedData.types },
    domain: typedData.domain,
    primaryType: typedData.primaryType,
    message: typedData.message,
  };
  return JSON.stringify(payload, (_key, value: unknown) => (typeof value === "bigint" ? value.toString(10) : value));
}

/** A signer over a Circle developer-controlled EOA (the default Payment key, AD-15). EOA wallets only. */
export function circleDcwSigner(opts: CircleDcwSignerOptions): CheckSigner {
  if (opts.walletId.length === 0) throw new TypeError("walletId must be non-empty");
  const address = lowerAddress(opts.address);
  return {
    address,
    async signTypedData(typedData) {
      assertSignable(typedData);
      const res = await opts.client.signTypedData({ walletId: opts.walletId, data: circleTypedDataJson(typedData) });
      return checkSignature(res.data?.signature);
    },
  };
}
