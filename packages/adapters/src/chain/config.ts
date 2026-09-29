// Chain configuration (AD-1): every chain specific the adapters use comes from here, never from code.
import { Address, type Hex } from "@horos/schema";

export interface ChainConfig {
  readonly chainId: number;
  /** `[primary, secondary]` RPC URLs; reads fail over from the first to the second. */
  readonly rpcUrls: readonly [string, string];
  readonly usdc: Hex;
  /** The chain's minimum base fee in wei (Arc testnet: 20 gwei); local-key writes never bid below it. */
  readonly minBaseFeeWei: bigint;
}

/** Arc testnet defaults except the RPC URLs, which always come from validated env. */
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_USDC: Hex = "0x3600000000000000000000000000000000000000";
export const ARC_TESTNET_MIN_BASE_FEE_WEI = 20_000_000_000n;

/** Validate a ChainConfig. Throws `RangeError` / `ZodError` when malformed. */
export function chainConfig(input: {
  readonly chainId: number;
  readonly rpcUrls: readonly [string, string];
  readonly usdc: string;
  readonly minBaseFeeWei: bigint;
}): ChainConfig {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new RangeError("chainId must be a positive integer");
  for (const u of input.rpcUrls) {
    const url = new URL(u);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new RangeError("rpc urls must be http(s)");
  }
  if (input.minBaseFeeWei < 0n) throw new RangeError("minBaseFeeWei must be >= 0");
  return { chainId: input.chainId, rpcUrls: [input.rpcUrls[0], input.rpcUrls[1]], usdc: Address.parse(input.usdc), minBaseFeeWei: input.minBaseFeeWei };
}
