// viem clients for the deploy helper (the SDK's EOA path needs a public and a wallet client) and for the smoke test's
// `PolicyWallet.pay` simulation (`simulateContract`: nothing is sent). No transaction is sent from here. On-chain
// effects of the quickstart: the SDK's PolicyWallet deploy (sent by the deploy helper), and, in the enforced smoke
// test, one first-contact Limit write that Horos queues for the known-good address (one new-payee slot, reused across
// reruns). No USDC moves.
import type { Hex } from "@horos/schema";
import type { DeployPublicClient, EoaPaymentSource } from "@horos/sdk";
import { createPublicClient, createWalletClient, defineChain, http, webSocket, type Chain, type PrivateKeyAccount } from "viem";
import { arcTestnet } from "viem/chains";

/** `pay` plus the PolicyWallet's custom errors, so a simulated revert decodes to a reason. */
export const PAY_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "a", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "recordHash", type: "bytes32" },
    ],
    outputs: [],
  },
  ...[
    "InvalidAmount",
    "NotRegistered",
    "Pinned",
    "PayeeIsContract",
    "LimitExceeded",
    "WalletCapExceeded",
    "Unauthorized",
    "RoleVacant",
    "DayIndexOverflow",
  ].map((name) => ({ type: "error", name, inputs: [] }) as const),
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
] as const;

/** What the smoke test needs from a public client (a viem `PublicClient` satisfies it). */
export interface PaySimulator {
  getChainId(): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  simulateContract(args: {
    address: Hex;
    abi: typeof PAY_ABI;
    functionName: "pay";
    args: readonly [Hex, bigint, Hex];
    account: PrivateKeyAccount | Hex;
  }): Promise<unknown>;
}

export function chainFor(chainId: number, rpcUrl: string | undefined): Chain {
  if (chainId === arcTestnet.id) {
    return rpcUrl === undefined ? arcTestnet : { ...arcTestnet, rpcUrls: { default: { http: [rpcUrl] } } };
  }
  if (rpcUrl === undefined) throw new Error("an RPC URL is required off Arc testnet");
  return defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
}

function transportFor(rpcUrl: string | undefined) {
  if (rpcUrl !== undefined && /^wss?:/.test(rpcUrl)) return webSocket(rpcUrl);
  return http(rpcUrl);
}

/** The reads the SDK deploy helper needs plus the pay simulation. */
export type QuickstartPublicClient = DeployPublicClient & PaySimulator;

export function publicClientFor(chainId: number, rpcUrl: string | undefined): QuickstartPublicClient {
  const chain = chainFor(chainId, rpcUrl);
  return createPublicClient({ chain, transport: transportFor(rpcUrl) }) as unknown as QuickstartPublicClient;
}

export function walletClientFor(chainId: number, rpcUrl: string | undefined, account: PrivateKeyAccount): EoaPaymentSource["walletClient"] {
  const chain = chainFor(chainId, rpcUrl);
  return createWalletClient({ account, chain, transport: transportFor(rpcUrl) });
}
