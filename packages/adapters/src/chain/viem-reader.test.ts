import { POLICY_WALLET_EVENT_NAMES, type Hex } from "@horos/schema";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  toFunctionSignature,
  toHex,
} from "viem";
import { describe, expect, test } from "vitest";
import { circleCall, encodeCall } from "./calls.js";
import { chainConfig } from "./config.js";
import { policyWalletAbi } from "./policy-wallet-abi.js";
import { ViemChainReader } from "./viem-reader.js";

const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const CP: Hex = "0x1111111111111111111111111111111111111111";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const config = chainConfig({ chainId: 5042002, rpcUrls: ["https://a.invalid", "https://b.invalid"], usdc: "0x3600000000000000000000000000000000000000", minBaseFeeWei: 1n });

const remainingResult = encodeFunctionResult({
  abi: policyWalletAbi,
  functionName: "remaining",
  result: {
    cpRemaining: 1n,
    walletRemaining: 2n,
    newPayeeRemaining: 3n,
    limit: 4n,
    pinned: false,
    registered: true,
    humanSet: false,
    humanEpoch: 5n,
  },
});

type Handler = (method: string, params: unknown) => unknown;
const transport = (h: Handler) =>
  custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_chainId") return "0x4cef52";
      return h(method, params);
    },
  });
const down: Handler = () => {
  throw new Error("primary down");
};
class RpcRevert extends Error {
  readonly code = 3;
  constructor(readonly data: Hex) {
    super("execution reverted");
  }
}

describe("ViemChainReader", () => {
  test("remaining fails over from the primary to the secondary RPC", async () => {
    const calls: string[] = [];
    const r = new ViemChainReader(config, {
      transports: [
        transport(down),
        transport((m) => {
          calls.push(m);
          return remainingResult;
        }),
      ],
    });
    expect(await r.remaining(WALLET, CP)).toEqual({
      cpRemaining: 1n,
      walletRemaining: 2n,
      newPayeeRemaining: 3n,
      limit: 4n,
      pinned: false,
      registered: true,
      humanSet: false,
      humanEpoch: 5n,
    });
    expect(calls).toEqual(["eth_call"]);
  });

  test("both RPCs down rejects", async () => {
    const r = new ViemChainReader(config, { transports: [transport(down), transport(down)] });
    await expect(r.remaining(WALLET, CP)).rejects.toThrow();
  });

  test("simulate returns ok, or the custom-error name of a revert without failing over", async () => {
    const stale = encodeErrorResult({ abi: policyWalletAbi, errorName: "StaleEpoch" });
    let secondary = 0;
    const r = new ViemChainReader(config, {
      transports: [
        transport(() => {
          throw new RpcRevert(stale);
        }),
        transport(() => {
          secondary++;
          return "0x";
        }),
      ],
    });
    expect(await r.simulate(WALLET, { fn: "tighten", counterparty: CP, limit: 1n, expectedEpoch: 9n, recordHash: HASH }, CP)).toEqual({
      ok: false,
      revert: "StaleEpoch",
    });
    expect(secondary).toBe(0);
    const ok = new ViemChainReader(config, { transports: [transport(() => "0x"), transport(down)] });
    expect(await ok.simulate(WALLET, { fn: "pin", counterparty: CP, recordHash: HASH }, CP)).toEqual({ ok: true });
  });

  test("roles maps Role indices 0..3 and human(), lowercasing checksummed addresses; policy decodes the struct", async () => {
    // Checksummed (mixed-case) addresses, as a node returns them.
    const holders = [
      getAddress("0x705f7d75b1689c42034ca5102700be481edca2da"), // Payment (0)
      getAddress("0x7434fc9d31febe08082a710b255f3fe51b6a7ffc"), // Registrar (1)
      getAddress("0x081b31405e48ec71bedbc22adf10ebcdcabb69a7"), // Model (2)
      getAddress("0x9542e0bbc0bcc0c88033233d7d70b0def37e2769"), // Rules (3)
    ] as const;
    const HUMAN = getAddress("0x3b60ebece31658efda2ad1cd28860cabbf2e4e85");
    expect(HUMAN).not.toBe(HUMAN.toLowerCase());
    const answer: Handler = (method, params) => {
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const data = (params as [{ data: Hex }])[0].data;
      const call = decodeFunctionData({ abi: policyWalletAbi, data });
      if (call.functionName === "roleHolder") {
        const i = Number(call.args[0]);
        return encodeFunctionResult({ abi: policyWalletAbi, functionName: "roleHolder", result: holders[i] ?? "0x0000000000000000000000000000000000000000" });
      }
      if (call.functionName === "human") return encodeFunctionResult({ abi: policyWalletAbi, functionName: "human", result: HUMAN });
      if (call.functionName === "policy") {
        return encodeFunctionResult({
          abi: policyWalletAbi,
          functionName: "policy",
          result: { firstContactCeiling: 500_000_000n, walletPeriodCap: 5_000_000_000n, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n },
        });
      }
      throw new Error(`unexpected ${call.functionName}`);
    };
    const r = new ViemChainReader(config, { transports: [transport(answer), transport(down)] });
    expect(await r.roles(WALLET)).toEqual({
      payment: holders[0].toLowerCase(),
      registrar: holders[1].toLowerCase(),
      model: holders[2].toLowerCase(),
      rules: holders[3].toLowerCase(),
      human: HUMAN.toLowerCase(),
    });
    expect(await r.policy(WALLET)).toEqual({
      firstContactCeiling: 500_000_000n,
      walletPeriodCap: 5_000_000_000n,
      newPayeeCap: 10n,
      policyPeriodDays: 30n,
      unpinDelay: 86_400n,
    });
  });

  test("hasCode", async () => {
    const r = new ViemChainReader(config, { transports: [transport((m) => (m === "eth_getCode" ? "0x6000" : "0x")), transport(down)] });
    expect(await r.hasCode(WALLET)).toBe(true);
    const e = new ViemChainReader(config, { transports: [transport(() => "0x"), transport(down)] });
    expect(await e.hasCode(WALLET)).toBe(false);
  });
});

describe("ViemChainReader indexer reads (Story 2.7)", () => {
  const eventLog = (eventName: "CounterpartyRegistered" | "LimitSet" | "RoleGranted", values: readonly unknown[], block: bigint, logIndex: number, tx: string) => {
    const item = policyWalletAbi.find((x) => x.type === "event" && x.name === eventName);
    if (item === undefined || item.type !== "event") throw new Error("not an event");
    return {
      address: WALLET,
      topics: encodeEventTopics({ abi: policyWalletAbi, eventName }),
      data: encodeAbiParameters(item.inputs, values as never),
      blockNumber: toHex(block),
      logIndex: toHex(logIndex),
      transactionHash: `0x${tx.repeat(64)}`,
      transactionIndex: "0x0",
      blockHash: `0x${"b".repeat(64)}`,
      removed: false,
    };
  };

  test("logs: decoded strictly, args canonical (lowercase hex, decimal strings), sorted by (block, logIndex), with failover", async () => {
    const CHECKSUMMED = getAddress("0x7434fc9d31febe08082a710b255f3fe51b6a7ffc");
    const seen: unknown[] = [];
    const r = new ViemChainReader(config, {
      transports: [
        transport(down),
        transport((m, params) => {
          if (m === "eth_blockNumber") return "0xb";
          if (m !== "eth_getLogs") throw new Error(`unexpected ${m}`);
          seen.push(params);
          return [
            eventLog("LimitSet", [CP, 0n, 300n, 1n, HASH], 11n, 1, "d"),
            eventLog("RoleGranted", [1, CHECKSUMMED, HASH], 10n, 4, "c"),
            eventLog("CounterpartyRegistered", [CP, 300n, HASH], 11n, 0, "d"),
          ];
        }),
      ],
    });
    const logs = await r.logs(WALLET, 10n, 11n);
    expect(seen).toMatchObject([[{ address: WALLET, fromBlock: "0xa", toBlock: "0xb" }]]);
    expect(logs).toEqual([
      { name: "RoleGranted", args: { role: "1", account: CHECKSUMMED.toLowerCase(), recordHash: HASH }, txHash: `0x${"c".repeat(64)}`, logIndex: 4, blockNumber: 10n },
      { name: "CounterpartyRegistered", args: { counterparty: CP, limit: "300", recordHash: HASH }, txHash: `0x${"d".repeat(64)}`, logIndex: 0, blockNumber: 11n },
      {
        name: "LimitSet",
        args: { counterparty: CP, oldLimit: "0", newLimit: "300", humanEpoch: "1", recordHash: HASH },
        txHash: `0x${"d".repeat(64)}`,
        logIndex: 1,
        blockNumber: 11n,
      },
    ]);
  });

  test("logs: an undecodable log throws (the indexer retries the chunk)", async () => {
    const bad = { ...eventLog("LimitSet", [CP, 0n, 1n, 1n, HASH], 1n, 0, "d"), topics: [`0x${"f".repeat(64)}`] };
    const serve = (m: string) => (m === "eth_blockNumber" ? "0x1" : [bad]);
    const r = new ViemChainReader(config, { transports: [transport(serve), transport(serve)] });
    await expect(r.logs(WALLET, 1n, 1n)).rejects.toThrow();
  });

  test("logs: a lagging RPC (head below toBlock) never serves the range; the other one does, else it throws", async () => {
    const good = eventLog("CounterpartyRegistered", [CP, 1n, HASH], 20n, 0, "d");
    const lagging = (m: string) => (m === "eth_blockNumber" ? "0x10" : []); // head 16: would return no logs for 20
    const current = (m: string) => (m === "eth_blockNumber" ? "0x14" : [good]);
    const primaryLags = new ViemChainReader(config, { transports: [transport(lagging), transport(current)] });
    expect((await primaryLags.logs(WALLET, 18n, 20n)).map((l) => l.blockNumber)).toEqual([20n]);
    const secondaryLags = new ViemChainReader(config, { transports: [transport(down), transport(lagging)] });
    await expect(secondaryLags.logs(WALLET, 18n, 20n)).rejects.toThrow(/behind block 20/);
  });

  test("latestBlock, blockTimestamp, txFrom, rolesAt and hasCodeAt read at the requested block", async () => {
    const FROM = getAddress("0x9542e0bbc0bcc0c88033233d7d70b0def37e2769");
    const calls: [string, unknown][] = [];
    const r = new ViemChainReader(config, {
      transports: [
        transport((m, params) => {
          calls.push([m, params]);
          switch (m) {
            case "eth_blockNumber":
              return "0x2a";
            case "eth_getBlockByNumber":
              return { number: "0x7", hash: `0x${"b".repeat(64)}`, timestamp: "0x66f7f0a0", transactions: [] };
            case "eth_getTransactionByHash":
              return { hash: HASH, from: FROM, to: WALLET, blockNumber: "0x7", nonce: "0x0", value: "0x0", input: "0x", type: "0x2" };
            case "eth_getCode":
              return (params as [string, string])[1] === "0x5" ? "0x6000" : "0x";
            case "eth_call": {
              const [call, block] = params as [{ data: Hex }, string];
              if (block !== "0x7") throw new Error(`eth_call at ${block}`);
              const fn = decodeFunctionData({ abi: policyWalletAbi, data: call.data });
              if (fn.functionName === "human") return encodeFunctionResult({ abi: policyWalletAbi, functionName: "human", result: FROM });
              return encodeFunctionResult({ abi: policyWalletAbi, functionName: "roleHolder", result: getAddress(`0x${String(fn.args?.[0]).repeat(40)}`) });
            }
          }
          throw new Error(`unexpected ${m}`);
        }),
        transport(down),
      ],
    });
    expect(await r.latestBlock()).toBe(42n);
    expect(await r.blockTimestamp(7n)).toBe(0x66f7f0a0n);
    expect(await r.txFrom(HASH)).toBe(FROM.toLowerCase());
    expect(await r.rolesAt(WALLET, 7n)).toEqual({
      payment: `0x${"0".repeat(40)}`,
      registrar: `0x${"1".repeat(40)}`,
      model: `0x${"2".repeat(40)}`,
      rules: `0x${"3".repeat(40)}`,
      human: FROM.toLowerCase(),
    });
    expect(await r.hasCodeAt(WALLET, 5n)).toBe(true);
    expect(await r.hasCodeAt(WALLET, 4n)).toBe(false);
    expect(calls.find(([m]) => m === "eth_getBlockByNumber")?.[1]).toEqual(["0x7", false]);
  });
});

describe("event vocabulary", () => {
  test("POLICY_WALLET_EVENT_NAMES equals the committed ABI's event names", () => {
    const abiEvents = policyWalletAbi.filter((x) => x.type === "event").map((x) => x.name);
    expect([...POLICY_WALLET_EVENT_NAMES].sort()).toEqual([...abiEvents].sort());
    expect(new Set(POLICY_WALLET_EVENT_NAMES).size).toBe(POLICY_WALLET_EVENT_NAMES.length);
  });
});

describe("calls", () => {
  test("encodeCall and circleCall cover every write; there is no setLimit", () => {
    expect(encodeCall({ fn: "register", counterparty: CP, limit: 7n, recordHash: HASH })).toEqual({ functionName: "register", args: [CP, 7n, HASH] });
    expect(encodeCall({ fn: "tighten", counterparty: CP, limit: 7n, expectedEpoch: 1n, recordHash: HASH }).functionName).toBe("tighten");
    expect(circleCall({ fn: "pin", counterparty: CP, recordHash: HASH })).toEqual({ abiFunctionSignature: "pin(address,bytes32)", abiParameters: [CP, HASH] });
  });

  test("circleCall signatures match the committed PolicyWallet ABI", () => {
    const sig = (name: "register" | "tighten" | "pin") => toFunctionSignature(getAbiItem({ abi: policyWalletAbi, name }));
    expect(circleCall({ fn: "register", counterparty: CP, limit: 1n, recordHash: HASH }).abiFunctionSignature).toBe(sig("register"));
    expect(circleCall({ fn: "tighten", counterparty: CP, limit: 1n, expectedEpoch: 0n, recordHash: HASH }).abiFunctionSignature).toBe(sig("tighten"));
    expect(circleCall({ fn: "pin", counterparty: CP, recordHash: HASH }).abiFunctionSignature).toBe(sig("pin"));
  });

  test("chainConfig validates", () => {
    expect(() => chainConfig({ ...config, rpcUrls: ["ftp://x", "https://y"], usdc: config.usdc })).toThrow(RangeError);
    expect(() => chainConfig({ ...config, chainId: 0 })).toThrow(RangeError);
  });
});

describe("ViemChainReader RPC limits", () => {
  class RpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
    ) {
      super(message);
    }
  }
  // No viem-level retries: the reader's own backoff is under test.
  const bare = (h: Handler) =>
    custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === "eth_chainId") return "0x4cef52";
          return h(method, params);
        },
      },
      { retryCount: 0 },
    );
  const logAt = (block: bigint, logIndex = 0) => ({
    address: WALLET,
    topics: encodeEventTopics({ abi: policyWalletAbi, eventName: "CounterpartyRegistered" }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [CP, block, HASH]),
    blockNumber: toHex(block),
    logIndex: toHex(logIndex),
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0",
    blockHash: `0x${"b".repeat(64)}`,
    removed: false,
  });

  /** A node holding one log per block in `blocks` that answers at most `cap` logs per query. */
  const capped = (blocks: readonly bigint[], cap: number, opts: { suggest?: boolean } = {}) => {
    const ranges: [bigint, bigint][] = [];
    const handler: Handler = (m, params) => {
      if (m === "eth_blockNumber") return toHex(1000n);
      if (m !== "eth_getLogs") throw new Error(`unexpected ${m}`);
      const q = (params as [{ fromBlock: Hex; toBlock: Hex }])[0];
      const from = BigInt(q.fromBlock);
      const to = BigInt(q.toBlock);
      ranges.push([from, to]);
      const hit = blocks.filter((b) => b >= from && b <= to);
      if (hit.length > cap) {
        const last = hit[cap - 1] as bigint;
        const hint = opts.suggest === false ? "" : `, retry with the range ${from}-${last}`;
        throw new RpcError(-32602, `request exceeded max allowed range: query exceeds max results ${cap}${hint}`);
      }
      return hit.map((b) => logAt(b));
    };
    return { handler, ranges };
  };

  test("logs: a range over the result cap is split at the provider's suggested bound, results in chain order", async () => {
    const blocks = [100n, 105n, 110n, 120n, 130n, 140n, 150n];
    const node = capped(blocks, 3);
    const r = new ViemChainReader(config, { transports: [bare(node.handler), bare(down)] });
    const logs = await r.logs(WALLET, 100n, 200n);
    expect(logs.map((l) => l.blockNumber)).toEqual(blocks);
    // 100-200 over cap → 100-110 (suggested) + 111-200 over cap → 111-140 (suggested) + 141-200.
    expect(node.ranges).toEqual([
      [100n, 200n],
      [100n, 110n],
      [111n, 200n],
      [111n, 140n],
      [141n, 200n],
    ]);
  });

  test("logs: without a suggested range the reader halves until each part fits", async () => {
    const blocks = [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n];
    const node = capped(blocks, 2, { suggest: false });
    const r = new ViemChainReader(config, { transports: [bare(node.handler), bare(down)] });
    expect((await r.logs(WALLET, 0n, 7n)).map((l) => l.blockNumber)).toEqual(blocks);
    expect(node.ranges.slice(0, 3)).toEqual([
      [0n, 7n],
      [0n, 3n],
      [0n, 1n],
    ]);
  });

  test("logs: a single block over the cap throws a clear error", async () => {
    const node = capped([5n], 0, { suggest: false });
    const r = new ViemChainReader(config, { transports: [bare(node.handler), bare(node.handler)] });
    await expect(r.logs(WALLET, 5n, 5n)).rejects.toThrow(/block 5 alone holds more logs/);
  });

  test("a rate-limited read is retried with bounded backoff, then succeeds on the same RPC", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = new ViemChainReader(config, {
      transports: [
        bare(() => {
          if (++calls <= 2) throw new RpcError(-32005, "rate limit exceeded");
          return remainingResult;
        }),
        bare(down),
      ],
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 1,
    });
    expect((await r.remaining(WALLET, CP)).limit).toBe(4n);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([200, 400]);
  });

  test("an always rate-limited primary fails over to the secondary; both limited rejects", async () => {
    const limited = () => {
      throw new RpcError(-32005, "rate limit exceeded");
    };
    const sleeps: number[] = [];
    let secondary = 0;
    const ok = new ViemChainReader(config, {
      transports: [
        bare(limited),
        bare(() => {
          secondary++;
          return remainingResult;
        }),
      ],
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 1,
    });
    expect((await ok.remaining(WALLET, CP)).limit).toBe(4n);
    expect(secondary).toBe(1);
    expect(sleeps).toEqual([200, 400, 800]);

    sleeps.length = 0;
    const r = new ViemChainReader(config, { transports: [bare(limited), bare(limited)], sleep: async (ms) => void sleeps.push(ms), random: () => 1 });
    await expect(r.remaining(WALLET, CP)).rejects.toThrow(/rate limit/i);
    expect(sleeps).toEqual([200, 400, 800, 200, 400, 800]);
    // The total backoff budget bounds the retries.
    sleeps.length = 0;
    const tight = new ViemChainReader(config, { transports: [bare(limited), bare(limited)], sleep: async (ms) => void sleeps.push(ms), random: () => 1, backoffTotalMs: 500 });
    await expect(tight.remaining(WALLET, CP)).rejects.toThrow();
    expect(sleeps).toEqual([200, 200]);
  });

  test("a contract revert is never retried nor failed over", async () => {
    const stale = encodeErrorResult({ abi: policyWalletAbi, errorName: "StaleEpoch" });
    let primary = 0;
    let secondary = 0;
    const sleeps: number[] = [];
    const r = new ViemChainReader(config, {
      transports: [
        bare(() => {
          primary++;
          throw new RpcRevert(stale);
        }),
        bare(() => {
          secondary++;
          return "0x";
        }),
      ],
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(await r.simulate(WALLET, { fn: "pin", counterparty: CP, recordHash: HASH }, CP)).toEqual({ ok: false, revert: "StaleEpoch" });
    expect([primary, secondary, sleeps.length]).toEqual([1, 0, 0]);
  });
});
