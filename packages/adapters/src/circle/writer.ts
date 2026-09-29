// Circle ChainWriter (AD-15): Registrar/Rules writes as developer-controlled `contractExecution`
// transactions from the Customer's provisioned EOAs (founder-funded; no Gas Station).
import type { ChainWriter, WriteRequest, WriteStatus } from "@horos/core";
import type { Hex } from "@horos/schema";
import { circleCall } from "../chain/calls.js";
import type { CircleClient, CircleFeeLevel } from "./client.js";

export interface CircleChainWriterOptions {
  readonly feeLevel?: CircleFeeLevel;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/u;

export class CircleChainWriter implements ChainWriter {
  private readonly feeLevel: CircleFeeLevel;
  constructor(
    private readonly client: CircleClient,
    opts: CircleChainWriterOptions = {},
  ) {
    this.feeLevel = opts.feeLevel ?? "MEDIUM";
  }

  async send(req: WriteRequest): Promise<{ readonly txId: string }> {
    const walletId = req.signer.circleWalletId;
    if (walletId === undefined) throw new Error("circle writes need the signer's Circle wallet id");
    const { abiFunctionSignature, abiParameters } = circleCall(req.call);
    const r = await this.client.createContractExecution({
      walletId,
      contractAddress: req.policyWallet,
      abiFunctionSignature,
      abiParameters,
      feeLevel: this.feeLevel,
      idempotencyKey: req.idempotencyKey,
      ...(req.refId === undefined ? {} : { refId: req.refId }),
    });
    return { txId: r.id };
  }

  async status(txId: string): Promise<WriteStatus> {
    const t = await this.client.getTransaction(txId);
    const error = t.errorReason ?? t.state;
    switch (t.state) {
      case "COMPLETE":
        if (t.txHash === undefined || !TX_HASH_RE.test(t.txHash)) return { state: "pending" };
        return { state: "complete", txHash: t.txHash.toLowerCase() as Hex };
      case "FAILED":
        return { state: "failed", error };
      case "DENIED":
        return { state: "denied", error };
      case "CANCELLED":
        return { state: "cancelled", error };
      default:
        // Includes STUCK, which can still mine: keep waiting rather than resending under a new key.
        return { state: "pending" };
    }
  }
}
