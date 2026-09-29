// Story 2.7 end to end on anvil: deploy the PolicyWallet, register and tighten through the Story 2.6 outbox
// with LocalKeyChainWriter, a Human `setLimit`, then index → confirmed receipts plus one ExternalRecord.
// Gated on HOROS_TEST_ANVIL=1 (needs `anvil` on PATH and `forge build` output in contracts/out).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  chainConfig,
  LocalKeyChainWriter,
  outboxExtraWrites,
  policyWalletAbi,
  PostgresAccountStore,
  PostgresIndexerStore,
  PostgresJobStore,
  PostgresListStore,
  PostgresOutboxStore,
  PostgresRecordStore,
  runMigrations,
  uuidv7,
  ViemChainReader,
  type ChainConfig,
} from "@horos/adapters";
import { buildDecisionRecord, evaluate, STANDARD_PRESET, type ChainView, type FounderAlert, type ListSnapshot, type Notifier } from "@horos/core";
import { isExternalRecord, toWireTime, ZERO_BYTES32, type Hex, type Scope } from "@horos/schema";
import { drizzle } from "drizzle-orm/pglite";
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWorker, type Worker } from "./tick.js";

// Anvil's default dev mnemonic (never funded on any real network).
const MNEMONIC = "test test test test test test test test test test test junk";
const keyAt = (i: number): Hex => {
  const pk = mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey;
  if (pk === null) throw new Error("no key");
  return toHex(pk);
};
const human = privateKeyToAccount(keyAt(0));
const payment = privateKeyToAccount(keyAt(1));
const registrar = privateKeyToAccount(keyAt(2));
const model = privateKeyToAccount(keyAt(3));
const rules = privateKeyToAccount(keyAt(4));
const lower = (a: string) => a.toLowerCase() as Hex;
const CP: Hex = "0x1111111111111111111111111111111111111111";
const CP2: Hex = "0x2222222222222222222222222222222222222222";
const USDC = 1_000_000n;

class RecordingNotifier implements Notifier {
  readonly alerts: FounderAlert[] = [];
  async notify(alert: FounderAlert) {
    this.alerts.push(alert);
  }
}

describe.skipIf(process.env["HOROS_TEST_ANVIL"] !== "1")("indexer end to end on anvil", () => {
  let anvil: ChildProcess | undefined;
  let config: ChainConfig;
  let url: string;
  let wallet: Hex;
  const pg = new PGlite();

  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    anvil = spawn("anvil", ["--port", String(port), "--hardfork", "osaka", "--silent"], { stdio: "ignore" });
    url = `http://127.0.0.1:${port}`;
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
    const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/PolicyWallet.sol/PolicyWallet.json", import.meta.url), "utf8")) as {
      bytecode: { object: Hex };
    };
    const deployer = createWalletClient({ account: human, chain, transport: http(url) });
    // Mine a few empty blocks first so the deploy-block search has something to skip.
    await pub.request({ method: "anvil_mine" as never, params: ["0x5"] as never });
    const hash = await deployer.deployContract({
      abi: policyWalletAbi,
      bytecode: artifact.bytecode.object,
      args: [
        { human: human.address, payment: payment.address, registrar: registrar.address, model: model.address, rules: rules.address },
        { firstContactCeiling: 500n * USDC, walletPeriodCap: 5_000n * USDC, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n },
        false,
      ],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.contractAddress == null) throw new Error("deploy failed");
    wallet = lower(receipt.contractAddress);
  }, 60_000);

  afterAll(async () => {
    anvil?.kill();
    await pg.close();
  });

  test("register (2.6 race) and tighten via the outbox, a Human setLimit, then index: confirmed receipts + one ExternalRecord", async () => {
    const db = drizzle(pg);
    await runMigrations(db);
    const accounts = new PostgresAccountStore(db);
    const records = new PostgresRecordStore(db);
    const outbox = new PostgresOutboxStore(db);
    const store = new PostgresIndexerStore(db);
    const notifier = new RecordingNotifier();
    const now = () => new Date();
    const { binding } = await accounts.onboard({ paymentAddress: lower(payment.address), webhookUrl: "", now: now() });
    await accounts.setKeys(
      binding.customerId,
      {
        walletSetId: "local",
        registrar: { walletId: "local-registrar", address: lower(registrar.address) },
        model: { walletId: "local-model", address: lower(model.address) },
        rules: { walletId: "local-rules", address: lower(rules.address) },
      },
      now(),
    );
    const bound = await accounts.bind(binding.customerId, wallet, now());
    const scope = bound.scopeId as Scope;
    const reader = new ViemChainReader(config);
    const writer = new LocalKeyChainWriter(config, [keyAt(2), keyAt(4)]);
    const lists = (): ListSnapshot[] => [
      { source: "ofac-sdn", snapshotId: "sdn-0", snapshotHash: `0x${"a".repeat(64)}`, entries: new Map(), lastVerifiedAt: Date.now() },
    ];
    const jobs = new PostgresJobStore(db);
    const worker: Worker = createWorker({
      jobs,
      lists: new PostgresListStore(db),
      fetchSdn: async () => ({ status: 304 }),
      notifier,
      newId: () => uuidv7(),
      outbox: { accounts, outbox, records, reader, writer, notifier, loadLists: async () => lists(), newId: uuidv7 },
      indexer: { store, jobs, records, reader, notifier, newId: uuidv7, confirmations: 0n },
    });

    const decide = async (target: bigint, view: ChainView) => {
      const at = now();
      const e = evaluate({
        counterparty: CP,
        amount: 1n * USDC,
        declaredIdentity: { name: "Acme Data, Inc." },
        now: at.getTime(),
        lists: lists(),
        chain: { view, payeeIsContract: false, firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling },
        chainState: "live",
        hasHistory: true,
        identityBindings: [],
        pendingIntentTarget: target,
        policy: STANDARD_PRESET.offchain,
      });
      return records.append({
        scope,
        build: (seq, prevHash) =>
          buildDecisionRecord(
            {
              id: uuidv7(at.getTime()),
              scope,
              createdAt: toWireTime(at),
              trigger: "check",
              channel: "api",
              customerId: binding.customerId,
              policyWallet: wallet,
              counterparty: CP,
              amount: 1n * USDC,
              skippedQuestions: [],
              questionSetVersion: "v1",
              policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
              presetVersion: "standard@1",
              chainView: view,
              chainState: "live",
              evaluation: e,
            },
            seq,
            prevHash,
          ),
        extraWrites: outboxExtraWrites(e, { now: at, humanEpoch: view.humanEpoch }),
      });
    };
    const tickUntil = async (done: () => Promise<boolean>) => {
      for (let i = 0; i < 60; i++) {
        const r = await worker.tick(now());
        for (const w of r.indexer?.wallets ?? []) if (w.error !== undefined) throw new Error(w.error);
        if (await done()) return;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error("timed out");
    };

    // 1. The 2.6 race: 500 and 100 coalesce into one register(CP, 100).
    const first = await reader.remaining(wallet, CP);
    const [r500, r100] = await Promise.all([decide(500n * USDC, first), decide(100n * USDC, first)]);
    await tickUntil(async () => (await outbox.intentState(scope, CP, r100.record.id)) === "confirmed");
    expect(await outbox.intentState(scope, CP, r500.record.id)).toBe("confirmed");

    // 2. A tighten to 40 through the Rules lane.
    const registeredView = await reader.remaining(wallet, CP);
    expect(registeredView).toMatchObject({ registered: true, limit: 100n * USDC });
    const r40 = await decide(40n * USDC, registeredView);
    await tickUntil(async () => (await outbox.intentState(scope, CP, r40.record.id)) === "confirmed");

    // 3. A Human setLimit on a new Counterparty (emits CounterpartyRegistered + LimitSet).
    const chain = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } } as const;
    const humanClient = createWalletClient({ account: human, chain, transport: http(url) });
    const pub = createPublicClient({ chain, transport: http(url) });
    const setLimitTx = await humanClient.writeContract({ address: wallet, abi: policyWalletAbi, functionName: "setLimit", args: [CP2, 300n * USDC, ZERO_BYTES32] });
    await pub.waitForTransactionReceipt({ hash: setLimitTx });
    await tickUntil(async () => (await store.mirror(scope, CP2)) !== undefined);

    const receipts = await store.receipts(scope);
    expect(receipts.map((r) => [r.recordId, r.status, r.onchainLimitAfter]).sort()).toEqual(
      [
        [r500.record.id, "confirmed", 100n * USDC],
        [r100.record.id, "confirmed", 100n * USDC],
        [r40.record.id, "confirmed", 40n * USDC],
      ].sort(),
    );
    const externals = (await records.readChain(scope)).map((r) => r.record).filter(isExternalRecord);
    expect(externals).toHaveLength(1);
    expect(externals[0]).toMatchObject({ actor: "human", actorAddress: lower(human.address), txHash: lower(setLimitTx), counterparty: CP2 });
    expect(externals[0]?.events.map((e) => e.name)).toEqual(["CounterpartyRegistered", "LimitSet"]);
    expect(await store.mirror(scope, CP)).toMatchObject({ registered: true, limit: 40n * USDC, humanSet: false });
    expect(await store.mirror(scope, CP2)).toMatchObject({ registered: true, limit: 300n * USDC, humanSet: true, humanEpoch: 1n });
    expect(await store.monitoredSet(scope)).toEqual([CP, CP2]);
    expect(notifier.alerts).toEqual([]);
    // The cursor started at the deploy block (after the empty blocks) and caught up with the head.
    expect(await store.cursor(wallet)).toBe((await reader.latestBlock()) + 1n);
  }, 120_000);
});
