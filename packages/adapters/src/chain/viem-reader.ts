// viem ChainReader (AD-3, AD-7): live `remaining(a)`, roles, Policy, code and an `eth_call` pre-flight, plus
// the Story 2.7 indexer reads (block numbers, decoded PolicyWallet logs, block timestamps, tx senders,
// historical roles and code).
// Every read fails over from the primary to the secondary RPC. A contract revert in `simulate` is a
// result (`{revert: <error name>}`), never a failover trigger. A rate-limited RPC (-32005) is retried with bounded
// exponential backoff before the failover; an `eth_getLogs` range over the provider's result cap (-32602 "max
// results") is split and fetched piecewise.
import type { ChainReader, ChainView, LivePolicy, PolicyWalletCall, PolicyWalletLog, SimulateResult, WalletRoles } from "@horos/core";
import { PolicyWalletEventName, type Hex } from "@horos/schema";
import { BaseError, ContractFunctionRevertedError, createPublicClient, decodeEventLog, http, type Log, type PublicClient, type Transport } from "viem";
import { encodeCall } from "./calls.js";
import type { ChainConfig } from "./config.js";
import { policyWalletAbi } from "./policy-wallet-abi.js";

const ROLE_INDEX = { payment: 0, registrar: 1, model: 2, rules: 3 } as const;

export interface ViemChainReaderOptions {
  /** Override transports (tests). Defaults to `http(url)` per configured RPC URL. */
  readonly transports?: readonly [Transport, Transport];
  /** Retries per RPC after a rate-limit answer, before failing over. Default 3. */
  readonly rateLimitRetries?: number;
  /** First backoff delay; doubled per retry up to `backoffMaxMs`, then jittered to 50–100 %. Default 200 ms. */
  readonly backoffBaseMs?: number;
  /** Default 1600 ms. */
  readonly backoffMaxMs?: number;
  /** Total backoff budget per RPC per read; a retry that would exceed it is not made. Default 3000 ms. */
  readonly backoffTotalMs?: number;
  /** Test seams. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Errors along `err`'s cause chain (viem wraps the RPC's answer). */
function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  let e: unknown = err;
  for (let depth = 0; depth < 10 && typeof e === "object" && e !== null; depth++) {
    yield e as Record<string, unknown>;
    e = (e as { cause?: unknown }).cause;
  }
}

const errorText = (e: Record<string, unknown>): string => `${String(e["message"] ?? "")} ${String(e["details"] ?? "")}`;

/** A rate-limit answer: JSON-RPC -32005 / 429, HTTP 429, or a "rate limit" message. */
export function isRateLimited(err: unknown): boolean {
  for (const e of errorChain(err)) {
    if (e["code"] === -32005 || e["code"] === 429 || e["status"] === 429) return true;
    if (/rate limit/i.test(errorText(e))) return true;
  }
  return false;
}

/**
 * For an `eth_getLogs` answer over the provider's result cap (-32602 "query exceeds max results"): the provider's
 * suggested upper block ("retry with the range A-B") or null when none is given; undefined for any other error.
 */
export function maxResultsSplit(err: unknown): bigint | null | undefined {
  for (const e of errorChain(err)) {
    const text = errorText(e);
    if (!/max results/i.test(text)) continue;
    if (e["code"] !== undefined && e["code"] !== -32602) continue;
    const m = /retry with the range (\d+)\s*-\s*(\d+)/i.exec(text);
    return m?.[2] === undefined ? null : BigInt(m[2]);
  }
  return undefined;
}

/** The custom-error name of a viem contract revert, `"unknown"` when undecodable, or undefined when not a revert. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  return revert.data?.errorName ?? "unknown";
}

const lower = (a: string): Hex => a.toLowerCase() as Hex;

/** An event argument's canonical string: unsigned decimal for integers, lowercase hex for addresses/bytes. */
function canonicalArg(name: string, v: unknown): string {
  if (typeof v === "bigint") {
    if (v < 0n) throw new RangeError(`event arg ${name} is negative`);
    return v.toString(10);
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`event arg ${name} is not an unsigned integer`);
    return String(v);
  }
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
  throw new TypeError(`event arg ${name} has an unsupported type`);
}

export class ViemChainReader implements ChainReader {
  private readonly clients: readonly [PublicClient, PublicClient];
  private readonly retries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly backoffTotalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(config: ChainConfig, opts: ViemChainReaderOptions = {}) {
    this.retries = opts.rateLimitRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 200;
    this.backoffMaxMs = opts.backoffMaxMs ?? 1600;
    this.backoffTotalMs = opts.backoffTotalMs ?? 3000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
    const chain = {
      id: config.chainId,
      name: `chain-${config.chainId}`,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrls[0]] } },
    } as const;
    const t = opts.transports ?? [http(config.rpcUrls[0], { retryCount: 0 }), http(config.rpcUrls[1], { retryCount: 0 })];
    this.clients = [createPublicClient({ chain, transport: t[0] }), createPublicClient({ chain, transport: t[1] })];
  }

  /** Run `fn` on the primary; on any failure other than a contract revert, run it on the secondary. */
  private async failover<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
    try {
      return await this.backoff(() => fn(this.clients[0]));
    } catch (err) {
      if (revertName(err) !== undefined) throw err;
      return this.backoff(() => fn(this.clients[1]));
    }
  }

  /** `fn`, retried after a rate-limit answer with bounded exponential backoff and jitter. Nothing else is retried. */
  private async backoff<T>(fn: () => Promise<T>): Promise<T> {
    let slept = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= this.retries || !isRateLimited(err)) throw err;
        const cap = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt);
        const delay = Math.round(cap * (0.5 + this.random() * 0.5));
        if (slept + delay > this.backoffTotalMs) throw err;
        slept += delay;
        await this.sleep(delay);
      }
    }
  }

  /**
   * `eth_getLogs` over `[fromBlock, toBlock]` on `c`, split when the provider caps the result count: at its
   * suggested upper block when given, else in halves, fetching the parts in chain order.
   */
  private async getLogsSplit(c: PublicClient, policyWallet: Hex, fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    try {
      return await c.getLogs({ address: policyWallet, fromBlock, toBlock });
    } catch (err) {
      const suggested = maxResultsSplit(err);
      if (suggested === undefined) throw err;
      if (fromBlock >= toBlock) throw new Error(`block ${fromBlock} alone holds more logs than the RPC returns in one query`, { cause: err });
      const mid = suggested !== null && suggested >= fromBlock && suggested < toBlock ? suggested : fromBlock + (toBlock - fromBlock) / 2n;
      const head = await this.getLogsSplit(c, policyWallet, fromBlock, mid);
      const tail = await this.getLogsSplit(c, policyWallet, mid + 1n, toBlock);
      return [...head, ...tail];
    }
  }

  async remaining(policyWallet: Hex, counterparty: Hex): Promise<ChainView> {
    const r = await this.failover((c) =>
      c.readContract({ address: policyWallet, abi: policyWalletAbi, functionName: "remaining", args: [counterparty] }),
    );
    return {
      cpRemaining: r.cpRemaining,
      walletRemaining: r.walletRemaining,
      newPayeeRemaining: r.newPayeeRemaining,
      limit: r.limit,
      pinned: r.pinned,
      registered: r.registered,
      humanSet: r.humanSet,
      humanEpoch: r.humanEpoch,
    };
  }

  async roles(policyWallet: Hex): Promise<WalletRoles> {
    return this.readRoles(policyWallet, undefined);
  }

  async rolesAt(policyWallet: Hex, block: bigint): Promise<WalletRoles> {
    return this.readRoles(policyWallet, block);
  }

  private async readRoles(policyWallet: Hex, blockNumber: bigint | undefined): Promise<WalletRoles> {
    const at = blockNumber === undefined ? {} : { blockNumber };
    return this.failover(async (c) => {
      const holder = (role: keyof typeof ROLE_INDEX) =>
        c.readContract({ address: policyWallet, abi: policyWalletAbi, functionName: "roleHolder", args: [ROLE_INDEX[role]], ...at });
      const [payment, registrar, model, rules, human] = await Promise.all([
        holder("payment"),
        holder("registrar"),
        holder("model"),
        holder("rules"),
        c.readContract({ address: policyWallet, abi: policyWalletAbi, functionName: "human", ...at }),
      ]);
      return { payment: lower(payment), registrar: lower(registrar), model: lower(model), rules: lower(rules), human: lower(human) };
    });
  }

  async policy(policyWallet: Hex): Promise<LivePolicy> {
    const p = await this.failover((c) => c.readContract({ address: policyWallet, abi: policyWalletAbi, functionName: "policy" }));
    return {
      firstContactCeiling: p.firstContactCeiling,
      walletPeriodCap: p.walletPeriodCap,
      newPayeeCap: p.newPayeeCap,
      policyPeriodDays: p.policyPeriodDays,
      unpinDelay: p.unpinDelay,
    };
  }

  async hasCode(address: Hex): Promise<boolean> {
    const code = await this.failover((c) => c.getCode({ address }));
    return code !== undefined && code !== "0x";
  }

  async hasCodeAt(address: Hex, block: bigint): Promise<boolean> {
    const code = await this.failover((c) => c.getCode({ address, blockNumber: block }));
    return code !== undefined && code !== "0x";
  }

  async latestBlock(): Promise<bigint> {
    return this.failover((c) => c.getBlockNumber({ cacheTime: 0 }));
  }

  async blockTimestamp(block: bigint): Promise<bigint> {
    const b = await this.failover((c) => c.getBlock({ blockNumber: block }));
    return b.timestamp;
  }

  async txFrom(txHash: Hex): Promise<Hex> {
    const tx = await this.failover((c) => c.getTransaction({ hash: txHash }));
    return lower(tx.from);
  }

  /**
   * Every log `policyWallet` emitted in `[fromBlock, toBlock]`, decoded strictly with the committed ABI and
   * sorted by (block, logIndex). A log that does not decode, a pending log, or no RPC whose head has reached
   * `toBlock` throws: the indexer retries.
   */
  async logs(policyWallet: Hex, fromBlock: bigint, toBlock: bigint): Promise<PolicyWalletLog[]> {
    // A lagging node answers `eth_getLogs` for blocks it has not reached with an empty list, so the client
    // that serves the logs must itself be at or past `toBlock`; otherwise the next one is tried.
    const raw = await this.failover(async (c) => {
      const head = await c.getBlockNumber({ cacheTime: 0 });
      if (head < toBlock) throw new Error(`rpc head ${head} is behind block ${toBlock}; retry later`);
      return this.getLogsSplit(c, policyWallet, fromBlock, toBlock);
    });
    const out = raw.map((log): PolicyWalletLog => {
      if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) throw new Error("pending log in a mined range");
      const decoded = decodeEventLog({ abi: policyWalletAbi, data: log.data, topics: log.topics, strict: true });
      const name = PolicyWalletEventName.parse(decoded.eventName);
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(decoded.args as Record<string, unknown>)) args[k] = canonicalArg(k, v);
      return { name, args, txHash: lower(log.transactionHash), logIndex: log.logIndex, blockNumber: log.blockNumber };
    });
    return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }

  async simulate(policyWallet: Hex, call: PolicyWalletCall, from: Hex): Promise<SimulateResult> {
    const enc = encodeCall(call);
    try {
      await this.failover((c) =>
        c.simulateContract({ address: policyWallet, abi: policyWalletAbi, functionName: enc.functionName, args: enc.args as never, account: from }),
      );
      return { ok: true };
    } catch (err) {
      const name = revertName(err);
      if (name === undefined) throw err;
      return { ok: false, revert: name };
    }
  }
}
