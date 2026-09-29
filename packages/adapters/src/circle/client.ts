// The narrow slice of Circle's developer-controlled-wallets SDK (10.8.1) Horos uses (AD-15). Tests use a
// fake; `circleClientFromSdk` wraps the real SDK. The API key and entity secret are worker-only and are
// never logged or echoed in errors.
import { createHash } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

export const CIRCLE_BLOCKCHAIN = "ARC-TESTNET";

export type CircleFeeLevel = "LOW" | "MEDIUM" | "HIGH";

export type CircleTransactionState =
  | "INITIATED"
  | "CLEARED"
  | "QUEUED"
  | "SENT"
  | "STUCK"
  | "CONFIRMED"
  | "COMPLETE"
  | "FAILED"
  | "DENIED"
  | "CANCELLED";

export interface CircleWallet {
  readonly id: string;
  readonly address: string;
  readonly refId?: string;
}

export interface CircleContractExecutionInput {
  readonly walletId: string;
  readonly contractAddress: string;
  readonly abiFunctionSignature: string;
  readonly abiParameters: readonly string[];
  readonly feeLevel: CircleFeeLevel;
  readonly idempotencyKey: string;
  readonly refId?: string;
}

export interface CircleTransaction {
  readonly state: CircleTransactionState;
  readonly txHash?: string;
  readonly errorReason?: string;
}

export interface CircleClient {
  createWalletSet(input: { readonly name: string; readonly idempotencyKey: string }): Promise<{ readonly id: string }>;
  createWallets(input: {
    readonly walletSetId: string;
    readonly refIds: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<readonly CircleWallet[]>;
  createContractExecution(input: CircleContractExecutionInput): Promise<{ readonly id: string; readonly state: CircleTransactionState }>;
  getTransaction(id: string): Promise<CircleTransaction>;
}

/**
 * A UUID-formatted (version-4 layout) key derived deterministically from `seed`, so a retried call
 * reuses Circle's idempotency record.
 */
export function deterministicUuid(seed: string): string {
  const b = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  b[6] = 0x40 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface CircleSdkConfig {
  readonly apiKey: string;
  readonly entitySecret: string;
  readonly baseUrl?: string;
}

/** Circle SDK errors can quote request config (including headers); only a status/code survives. */
function sanitize(op: string, err: unknown): Error {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } } | undefined;
  const status = e?.status ?? e?.response?.status ?? e?.code;
  return new Error(`circle ${op} failed${status === undefined ? "" : ` (${String(status)})`}`);
}

async function call<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw sanitize(op, err);
  }
}

/** Wrap the real SDK. */
export function circleClientFromSdk(config: CircleSdkConfig): CircleClient {
  const sdk = initiateDeveloperControlledWalletsClient({
    apiKey: config.apiKey,
    entitySecret: config.entitySecret,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  });
  return {
    async createWalletSet(input) {
      const r = await call("createWalletSet", () => sdk.createWalletSet({ name: input.name, idempotencyKey: input.idempotencyKey }));
      const id = r.data?.walletSet.id;
      if (id === undefined) throw new Error("circle createWalletSet returned no wallet set");
      return { id };
    },
    async createWallets(input) {
      const r = await call("createWallets", () =>
        sdk.createWallets({
          walletSetId: input.walletSetId,
          blockchains: [CIRCLE_BLOCKCHAIN],
          count: input.refIds.length,
          accountType: "EOA",
          metadata: input.refIds.map((refId) => ({ name: `horos-${refId}`, refId })),
          idempotencyKey: input.idempotencyKey,
        }),
      );
      return (r.data?.wallets ?? []).map((w) => ({ id: w.id, address: w.address, ...(w.refId === undefined ? {} : { refId: w.refId }) }));
    },
    async createContractExecution(input) {
      const r = await call("createContractExecutionTransaction", () =>
        sdk.createContractExecutionTransaction({
          walletId: input.walletId,
          contractAddress: input.contractAddress,
          abiFunctionSignature: input.abiFunctionSignature,
          abiParameters: [...input.abiParameters],
          fee: { type: "level", config: { feeLevel: input.feeLevel } },
          idempotencyKey: input.idempotencyKey,
          ...(input.refId === undefined ? {} : { refId: input.refId }),
        }),
      );
      const d = r.data;
      if (d === undefined) throw new Error("circle createContractExecutionTransaction returned no transaction");
      return { id: d.id, state: d.state as CircleTransactionState };
    },
    async getTransaction(id) {
      const r = await call("getTransaction", () => sdk.getTransaction({ id }));
      const t = r.data?.transaction;
      if (t === undefined) throw new Error("circle getTransaction returned no transaction");
      return {
        state: t.state,
        ...(t.txHash === undefined ? {} : { txHash: t.txHash }),
        ...(t.errorReason === undefined ? {} : { errorReason: t.errorReason }),
      };
    },
  };
}
