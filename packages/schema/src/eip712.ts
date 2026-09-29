// EIP-712 domains and types for Agent Checks (AD-11) and Human actions (AD-12, AD-23).
// Shapes follow viem's `TypedData` (plain objects, `as const`).
import { declaredIdentityHash } from "./check.js";
import type { CheckRequest } from "./check.js";
import { Address, WireTime, type Hex } from "./primitives.js";

/** A signed Check may expire at most this many seconds after it is received. */
export const MAX_CHECK_EXPIRY_SECONDS = 300;

export const CHECK_DOMAIN_NAME = "Horos Check";
export const HUMAN_DOMAIN_NAME = "Horos Human";
export const EIP712_VERSION = "1";

export interface HorosDomain<N extends string> {
  readonly name: N;
  readonly version: typeof EIP712_VERSION;
  readonly chainId: number;
  readonly verifyingContract: Hex;
}

function domain<N extends string>(name: N, chainId: number, policyWallet: string): HorosDomain<N> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError("chainId must be a positive integer");
  return { name, version: EIP712_VERSION, chainId, verifyingContract: Address.parse(policyWallet) };
}

/** `{name: "Horos Check", version: "1", chainId, verifyingContract: policyWallet}` */
export function checkDomain(chainId: number, policyWallet: string): HorosDomain<typeof CHECK_DOMAIN_NAME> {
  return domain(CHECK_DOMAIN_NAME, chainId, policyWallet);
}

/** `{name: "Horos Human", version: "1", chainId, verifyingContract: policyWallet}` */
export function humanDomain(chainId: number, policyWallet: string): HorosDomain<typeof HUMAN_DOMAIN_NAME> {
  return domain(HUMAN_DOMAIN_NAME, chainId, policyWallet);
}

export const CHECK_PRIMARY_TYPE = "Check";
export const CHECK_TYPES = {
  Check: [
    { name: "policyWallet", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "declaredIdentityHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/**
 * Human actions. EIP-712 has no optionals: `newLimit` is 0 and `reasonHash` is `ZERO_BYTES32`
 * when absent. `kind` is a string so new kinds need no type-hash change.
 */
export const HUMAN_PRIMARY_TYPE = "HumanAction";
export const HUMAN_TYPES = {
  HumanAction: [
    { name: "policyWallet", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "kind", type: "string" },
    { name: "newLimit", type: "uint256" },
    { name: "reviewedRecordId", type: "string" },
    { name: "evidenceVectorHash", type: "bytes32" },
    { name: "reasonHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export interface CheckMessage {
  policyWallet: Hex;
  counterparty: Hex;
  amount: bigint;
  declaredIdentityHash: Hex;
  nonce: Hex;
  expiry: bigint;
}

export interface HumanActionMessage {
  policyWallet: Hex;
  counterparty: Hex;
  kind: string;
  newLimit: bigint;
  reviewedRecordId: string;
  evidenceVectorHash: Hex;
  reasonHash: Hex;
  nonce: Hex;
  expiry: bigint;
}

/**
 * Convert a wire time to uint64 unix seconds. Throws `ZodError` for a malformed wire time and
 * `RangeError` unless it is a whole second at or after the unix epoch.
 */
export function wireTimeToUnixSeconds(wireTime: string): bigint {
  const ms = Date.parse(WireTime.parse(wireTime));
  if (ms < 0) throw new RangeError("expiry must not be before the unix epoch");
  if (ms % 1000 !== 0) throw new RangeError("expiry must be a whole second (.000)");
  return BigInt(ms / 1000);
}

/**
 * The EIP-712 `Check` message for a parsed, authenticated request. Throws when `auth` is
 * missing or its expiry is not a whole second. Does not check the expiry window.
 */
export function checkMessageFromRequest(req: CheckRequest): CheckMessage {
  if (req.auth === undefined) throw new TypeError("check request has no auth envelope");
  return {
    policyWallet: req.policy_wallet,
    counterparty: req.counterparty,
    amount: BigInt(req.amount),
    declaredIdentityHash: declaredIdentityHash(req.declared_identity),
    nonce: req.auth.nonce,
    expiry: wireTimeToUnixSeconds(req.auth.expiry),
  };
}
