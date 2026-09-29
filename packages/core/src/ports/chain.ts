// Chain ports (AD-3, AD-7, AD-8, AD-15). Adapters implement them with viem (reads, local-key writes) and
// Circle `contractExecution` (hosted writes). Addresses crossing these ports are lowercase `0x` hex.
import type { Hex, PolicyWalletEventName } from "@horos/schema";
import type { ChainView } from "../evaluate/types.js";

/** The four grantable PolicyWallet role slots, in contract enum order. */
export type WalletRole = "payment" | "registrar" | "model" | "rules";

/** Live role holders plus the Human owner (lowercase; the zero address when vacant). */
export interface WalletRoles {
  readonly payment: Hex;
  readonly registrar: Hex;
  readonly model: Hex;
  readonly rules: Hex;
  readonly human: Hex;
}

/** The on-chain Policy (`policy()`), 6-dp USDC base units where amounts. */
export interface LivePolicy {
  readonly firstContactCeiling: bigint;
  readonly walletPeriodCap: bigint;
  readonly newPayeeCap: bigint;
  readonly policyPeriodDays: bigint;
  readonly unpinDelay: bigint;
}

/** The only PolicyWallet writes Horos ever sends. There is deliberately no `setLimit` (never a Raise). */
export type PolicyWalletCall =
  | { readonly fn: "register"; readonly counterparty: Hex; readonly limit: bigint; readonly recordHash: Hex }
  | {
      readonly fn: "tighten";
      readonly counterparty: Hex;
      readonly limit: bigint;
      readonly expectedEpoch: bigint;
      readonly recordHash: Hex;
    }
  | { readonly fn: "pin"; readonly counterparty: Hex; readonly recordHash: Hex };

/** The role whose key signs `call`: `register` → Registrar; `tighten` / `pin` → Rules. */
export function signingRoleOf(call: PolicyWalletCall): "registrar" | "rules" {
  return call.fn === "register" ? "registrar" : "rules";
}

/** `eth_call` pre-flight result: success, or the custom-error name (`"unknown"` when undecodable). */
export type SimulateResult = { readonly ok: true } | { readonly ok: false; readonly revert: string };

/**
 * A decoded PolicyWallet event log (Story 2.7). `args` maps each camelCase argument name to its canonical
 * string: uints and enum indexes as unsigned decimals, addresses and bytes32 as lowercase `0x` hex.
 */
export interface PolicyWalletLog {
  readonly name: PolicyWalletEventName;
  readonly args: Readonly<Record<string, string>>;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly blockNumber: bigint;
}

export interface ChainReader {
  remaining(policyWallet: Hex, counterparty: Hex): Promise<ChainView>;
  roles(policyWallet: Hex): Promise<WalletRoles>;
  policy(policyWallet: Hex): Promise<LivePolicy>;
  hasCode(address: Hex): Promise<boolean>;
  /** Simulate `call` from `from`. Resolves `{revert}` for a contract revert; rejects on RPC failure. */
  simulate(policyWallet: Hex, call: PolicyWalletCall, from: Hex): Promise<SimulateResult>;
  /** The latest block number. */
  latestBlock(): Promise<bigint>;
  /** Decoded PolicyWallet logs of `policyWallet` in `[fromBlock, toBlock]`, in chain order (block, logIndex). */
  logs(policyWallet: Hex, fromBlock: bigint, toBlock: bigint): Promise<PolicyWalletLog[]>;
  /** The block's timestamp in unix seconds. */
  blockTimestamp(block: bigint): Promise<bigint>;
  /** The sender (`tx.from`, lowercase) of a mined transaction. */
  txFrom(txHash: Hex): Promise<Hex>;
  /** Role holders and the Human as of `block`. */
  rolesAt(policyWallet: Hex, block: bigint): Promise<WalletRoles>;
  /** Whether `address` has code as of `block`. */
  hasCodeAt(address: Hex, block: bigint): Promise<boolean>;
}

/** The key a write is signed with: its address, plus the Circle wallet id for hosted keys. */
export interface WriteSigner {
  readonly address: Hex;
  readonly circleWalletId?: string;
}

export interface WriteRequest {
  readonly policyWallet: Hex;
  readonly call: PolicyWalletCall;
  readonly signer: WriteSigner;
  /** Stable per send attempt, so a crashed-and-retried attempt is deduplicated by the provider. */
  readonly idempotencyKey: string;
  /** Free-form reference (the outbox intent id). */
  readonly refId?: string;
}

/**
 * Where a sent write stands. `failed` is retryable (Circle `FAILED`, a mined revert); `denied` and
 * `cancelled` are terminal (Circle `DENIED` / `CANCELLED`).
 */
export type WriteStatus =
  | { readonly state: "pending" }
  | { readonly state: "complete"; readonly txHash: Hex }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "denied"; readonly error: string }
  | { readonly state: "cancelled"; readonly error: string };

export interface ChainWriter {
  /** Submit one write. Resolves the provider's transaction id; rejects (retryable) when submission fails. */
  send(req: WriteRequest): Promise<{ readonly txId: string }>;
  status(txId: string): Promise<WriteStatus>;
}
