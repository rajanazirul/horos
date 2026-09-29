// Local-key ChainWriter (AD-15): dev and CI only. Signs with in-memory private keys through viem; hosted
// deployments use CircleChainWriter. The transaction id is the transaction hash.
import type { ChainWriter, KeyProvisioner, ProvisionedKey, ProvisionedKeys, WriteRequest, WriteStatus } from "@horos/core";
import type { Hex } from "@horos/schema";
import {
  createPublicClient,
  createWalletClient,
  http,
  TransactionReceiptNotFoundError,
  type Chain,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeCall } from "./calls.js";
import type { ChainConfig } from "./config.js";
import { policyWalletAbi } from "./policy-wallet-abi.js";

export interface LocalKeyChainWriterOptions {
  readonly transport?: Transport;
}

export class LocalKeyChainWriter implements ChainWriter {
  private readonly accounts = new Map<string, PrivateKeyAccount>();
  private readonly chain: Chain;
  private readonly transport: Transport;
  private readonly client: PublicClient;

  /** `privateKeys`: the dev/CI role keys. They are never logged or echoed in errors. */
  constructor(
    private readonly config: ChainConfig,
    privateKeys: readonly Hex[],
    opts: LocalKeyChainWriterOptions = {},
  ) {
    for (const k of privateKeys) {
      const a = privateKeyToAccount(k);
      this.accounts.set(a.address.toLowerCase(), a);
    }
    this.chain = {
      id: config.chainId,
      name: `chain-${config.chainId}`,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrls[0]] } },
    };
    this.transport = opts.transport ?? http(config.rpcUrls[0], { retryCount: 0 });
    this.client = createPublicClient({ chain: this.chain, transport: this.transport });
  }

  async send(req: WriteRequest): Promise<{ readonly txId: string }> {
    const account = this.accounts.get(req.signer.address.toLowerCase());
    if (account === undefined) throw new Error(`no local key for signer ${req.signer.address}`);
    const wallet = createWalletClient({ account, chain: this.chain, transport: this.transport });
    const fees = await this.client.estimateFeesPerGas();
    const floor = this.config.minBaseFeeWei + fees.maxPriorityFeePerGas;
    const enc = encodeCall(req.call);
    const hash = await wallet.writeContract({
      address: req.policyWallet,
      abi: policyWalletAbi,
      functionName: enc.functionName,
      args: enc.args as never,
      maxFeePerGas: fees.maxFeePerGas > floor ? fees.maxFeePerGas : floor,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return { txId: hash };
  }

  async status(txId: string): Promise<WriteStatus> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: txId as Hex });
      return receipt.status === "success"
        ? { state: "complete", txHash: receipt.transactionHash.toLowerCase() as Hex }
        : { state: "failed", error: "transaction reverted" };
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return { state: "pending" };
      throw err;
    }
  }
}

/**
 * Dev/CI only, the counterpart of `LocalKeyChainWriter`: "provisions" every Customer with the addresses of the local
 * Registrar, Model and Rules keys, so onboarding works end to end against a local chain. Hosted deployments use
 * `CircleKeyProvisioner`.
 */
export function localKeyProvisioner(keys: { readonly registrar?: Hex; readonly model?: Hex; readonly rules?: Hex }): KeyProvisioner {
  const key = (role: "registrar" | "model" | "rules"): ProvisionedKey => {
    const pk = keys[role];
    if (pk === undefined) throw new Error(`no local ${role} key`);
    return { walletId: `local-${role}`, address: privateKeyToAccount(pk).address.toLowerCase() as Hex };
  };
  return {
    provision: async (): Promise<ProvisionedKeys> => ({ walletSetId: "local", registrar: key("registrar"), model: key("model"), rules: key("rules") }),
  };
}
