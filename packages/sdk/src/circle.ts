// Structural slices of the Circle clients the deploy helper uses (AD-15, AD-22): no Circle SDK dependency. The
// client from `initiateDeveloperControlledWalletsClient` (`@circle-fin/developer-controlled-wallets`) satisfies
// `CircleWalletsClient`; the client from `initiateSmartContractPlatformClient` (`@circle-fin/smart-contract-platform`)
// satisfies `CircleContractsClient`. Both run under the developer's own Circle account and entity secret.
import { keccak256, stringToHex } from "viem";
import type { CircleDcwClient } from "./signer.js";

/** Circle's blockchain id for Arc testnet. */
export const CIRCLE_ARC_TESTNET = "ARC-TESTNET";

export type CircleFeeLevel = "LOW" | "MEDIUM" | "HIGH";

export interface CircleWalletInfo {
  readonly id: string;
  readonly address: string;
  readonly blockchain?: string;
  readonly accountType?: string;
}

/** Circle developer-controlled wallets: wallet-set and EOA creation, lookup by address, and EIP-712 signing. */
export interface CircleWalletsClient extends CircleDcwClient {
  createWalletSet(input: { name: string; idempotencyKey?: string }): Promise<{ readonly data?: { readonly walletSet?: { readonly id: string } } | undefined }>;
  createWallets(input: {
    walletSetId: string;
    blockchains: string[];
    count: number;
    accountType?: "EOA" | "SCA";
    metadata?: { name?: string; refId?: string }[];
    idempotencyKey?: string;
  }): Promise<{ readonly data?: { readonly wallets?: readonly CircleWalletInfo[] } | undefined }>;
  listWallets(input?: { address?: string; blockchain?: string }): Promise<{ readonly data?: { readonly wallets?: readonly CircleWalletInfo[] } | undefined }>;
}

export interface CircleContractInfo {
  readonly id?: string;
  readonly contractAddress?: string;
  /** `PENDING`, `COMPLETE` or `FAILED`. */
  readonly status?: string;
  readonly deployStatus?: string;
}

/** Circle Contracts (Smart Contract Platform): deploy from ABI + bytecode, then poll the contract. */
export interface CircleContractsClient {
  deployContract(input: {
    name: string;
    description?: string;
    walletId: string;
    blockchain: string;
    abiJson: string;
    bytecode: string;
    constructorParameters?: unknown[];
    fee: { type: "level"; config: { feeLevel: CircleFeeLevel } };
    idempotencyKey?: string;
    refId?: string;
  }): Promise<{ readonly data?: { readonly contractId?: string; readonly transactionId?: string } | undefined }>;
  getContract(input: { id: string }): Promise<{ readonly data?: { readonly contract?: CircleContractInfo } | undefined }>;
}

/**
 * A UUID-formatted (version-4 layout) idempotency key derived deterministically from `parts`, so a rerun with the same
 * inputs reuses Circle's idempotency record instead of creating a second wallet or contract.
 */
export function circleIdempotencyKey(...parts: readonly string[]): string {
  const h = keccak256(stringToHex(`horos-sdk:${parts.join(":")}`)).slice(2, 34).split("");
  h[12] = "4";
  h[16] = "89ab"[parseInt(h[16] ?? "0", 16) & 3] ?? "8";
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
