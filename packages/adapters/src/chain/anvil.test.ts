// Anvil integration (Story 2.6): deploy the Foundry artifact, then register / tighten / pin through
// LocalKeyChainWriter and read back through ViemChainReader. Gated on HOROS_TEST_ANVIL=1 (needs `anvil`
// on PATH and `forge build` output in contracts/out).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Hex } from "@horos/schema";
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chainConfig, type ChainConfig } from "./config.js";
import { LocalKeyChainWriter } from "./local-writer.js";
import { policyWalletAbi } from "./policy-wallet-abi.js";
import { ViemChainReader } from "./viem-reader.js";

// Anvil's default dev mnemonic (never funded on any real network).
const MNEMONIC = "test test test test test test test test test test test junk";
const keyAt = (i: number): Hex => {
  const pk = mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey;
  if (pk === null) throw new Error("no key");
  return toHex(pk);
};
const KEYS: Hex[] = [0, 1, 2, 3, 4].map(keyAt);
const human = privateKeyToAccount(keyAt(0));
const payment = privateKeyToAccount(keyAt(1));
const registrar = privateKeyToAccount(keyAt(2));
const model = privateKeyToAccount(keyAt(3));
const rules = privateKeyToAccount(keyAt(4));
const CP: Hex = "0x1111111111111111111111111111111111111111";
const CP2: Hex = "0x2222222222222222222222222222222222222222";
const H = (c: string): Hex => `0x${c.repeat(64)}`;

describe.skipIf(process.env["HOROS_TEST_ANVIL"] !== "1")("PolicyWallet on anvil", () => {
  let anvil: ChildProcess | undefined;
  let config: ChainConfig;
  let wallet: Hex;
  let deployBlock: bigint;

  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    anvil = spawn("anvil", ["--port", String(port), "--hardfork", "osaka", "--silent"], { stdio: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    config = chainConfig({ chainId: 31337, rpcUrls: [url, url], usdc: "0x3600000000000000000000000000000000000000", minBaseFeeWei: 1n });
    const chain = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } } as const;
    const pub = createPublicClient({ chain, transport: http(url) });
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const artifact = JSON.parse(readFileSync(new URL("../../../../contracts/out/PolicyWallet.sol/PolicyWallet.json", import.meta.url), "utf8")) as {
      bytecode: { object: Hex };
    };
    const deployer = createWalletClient({ account: human, chain, transport: http(url) });
    const hash = await deployer.deployContract({
      abi: policyWalletAbi,
      bytecode: artifact.bytecode.object,
      args: [
        { human: human.address, payment: payment.address, registrar: registrar.address, model: model.address, rules: rules.address },
        { firstContactCeiling: 500_000_000n, walletPeriodCap: 5_000_000_000n, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n },
        false,
      ],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.contractAddress == null) throw new Error("deploy failed");
    wallet = receipt.contractAddress.toLowerCase() as Hex;
    deployBlock = receipt.blockNumber;
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  const waitComplete = async (writer: LocalKeyChainWriter, txId: string) => {
    for (let i = 0; i < 100; i++) {
      const s = await writer.status(txId);
      if (s.state !== "pending") return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("tx not mined");
  };

  test("roles, policy, register → tighten → pin, and a StaleEpoch simulation", async () => {
    const reader = new ViemChainReader({ ...config, rpcUrls: ["http://127.0.0.1:1", config.rpcUrls[1]] }); // primary down → failover
    const writer = new LocalKeyChainWriter(config, KEYS.slice(1));
    const lower = (a: string) => a.toLowerCase();
    expect(await reader.roles(wallet)).toEqual({
      payment: lower(payment.address),
      registrar: lower(registrar.address),
      model: lower(model.address),
      rules: lower(rules.address),
      human: lower(human.address),
    });
    expect((await reader.policy(wallet)).firstContactCeiling).toBe(500_000_000n);
    expect(await reader.hasCode(wallet)).toBe(true);
    expect(await reader.hasCode(CP)).toBe(false);

    const reg = { fn: "register", counterparty: CP, limit: 100_000_000n, recordHash: H("1") } as const;
    expect(await reader.simulate(wallet, reg, lower(rules.address) as Hex)).toEqual({ ok: false, revert: "Unauthorized" });
    expect(await reader.simulate(wallet, { ...reg, limit: 600_000_000n }, lower(registrar.address) as Hex)).toEqual({ ok: false, revert: "CeilingExceeded" });
    expect(await reader.simulate(wallet, reg, lower(registrar.address) as Hex)).toEqual({ ok: true });
    const s1 = await writer.send({ policyWallet: wallet, call: reg, signer: { address: lower(registrar.address) as Hex }, idempotencyKey: "a" });
    expect(await waitComplete(writer, s1.txId)).toMatchObject({ state: "complete" });
    expect(await reader.remaining(wallet, CP)).toMatchObject({ registered: true, limit: 100_000_000n, humanEpoch: 0n });

    const stale = { fn: "tighten", counterparty: CP, limit: 50_000_000n, expectedEpoch: 1n, recordHash: H("2") } as const;
    expect(await reader.simulate(wallet, stale, lower(rules.address) as Hex)).toEqual({ ok: false, revert: "StaleEpoch" });
    const s2 = await writer.send({ policyWallet: wallet, call: { ...stale, expectedEpoch: 0n }, signer: { address: lower(rules.address) as Hex }, idempotencyKey: "b" });
    expect(await waitComplete(writer, s2.txId)).toMatchObject({ state: "complete" });
    expect((await reader.remaining(wallet, CP)).limit).toBe(50_000_000n);

    const s3 = await writer.send({ policyWallet: wallet, call: { fn: "pin", counterparty: CP2, recordHash: H("3") }, signer: { address: lower(rules.address) as Hex }, idempotencyKey: "c" });
    expect(await waitComplete(writer, s3.txId)).toMatchObject({ state: "complete" });
    expect(await reader.remaining(wallet, CP2)).toMatchObject({ registered: true, pinned: true, limit: 0n });
    expect(await reader.simulate(wallet, { ...reg, counterparty: CP2 }, lower(registrar.address) as Hex)).toEqual({ ok: false, revert: "Pinned" });

    await expect(writer.send({ policyWallet: wallet, call: reg, signer: { address: lower(human.address) as Hex }, idempotencyKey: "d" })).rejects.toThrow(/no local key/);
  }, 60_000);

  test("indexer reads (Story 2.7): decoded logs in chain order, tx senders, historical code and roles, block timestamps", async () => {
    const reader = new ViemChainReader({ ...config, rpcUrls: ["http://127.0.0.1:1", config.rpcUrls[1]] });
    const latest = await reader.latestBlock();
    expect(latest).toBeGreaterThan(deployBlock);
    expect(await reader.hasCodeAt(wallet, deployBlock)).toBe(true);
    expect(await reader.hasCodeAt(wallet, deployBlock - 1n)).toBe(false);
    const logs = await reader.logs(wallet, 0n, latest);
    expect(logs.map((l) => [l.name, l.args["counterparty"], l.args["recordHash"]])).toEqual([
      ["CounterpartyRegistered", CP, H("1")],
      ["LimitTightened", CP, H("2")],
      ["CounterpartyRegistered", CP2, H("3")],
      ["CounterpartyPinned", CP2, H("3")],
    ]);
    expect(logs[1]?.args).toEqual({ counterparty: CP, oldLimit: "100000000", newLimit: "50000000", recordHash: H("2") });
    const [first, , third, fourth] = logs;
    if (first === undefined || third === undefined || fourth === undefined) throw new Error("missing logs");
    expect(third.txHash).toBe(fourth.txHash);
    expect(fourth.logIndex).toBeGreaterThan(third.logIndex);
    expect(await reader.txFrom(first.txHash)).toBe(registrar.address.toLowerCase());
    expect(await reader.txFrom(third.txHash)).toBe(rules.address.toLowerCase());
    expect((await reader.rolesAt(wallet, first.blockNumber)).registrar).toBe(registrar.address.toLowerCase());
    expect(await reader.blockTimestamp(first.blockNumber)).toBeGreaterThan(0n);
  }, 60_000);
});
