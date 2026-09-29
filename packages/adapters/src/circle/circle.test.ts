import type { WriteRequest } from "@horos/core";
import type { Hex } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { deterministicUuid, type CircleClient, type CircleContractExecutionInput, type CircleTransaction, type CircleWallet } from "./client.js";
import { CircleKeyProvisioner } from "./provisioner.js";
import { CircleChainWriter } from "./writer.js";

const CUSTOMER = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const CP: Hex = "0x1111111111111111111111111111111111111111";
const HASH: Hex = `0x${"ab".repeat(32)}`;

/** An idempotent fake: the same idempotency key returns the same result. */
class FakeCircle implements CircleClient {
  readonly sets = new Map<string, string>();
  readonly walletCalls = new Map<string, CircleWallet[]>();
  readonly executions: CircleContractExecutionInput[] = [];
  tx: CircleTransaction = { state: "QUEUED" };
  private n = 0;
  async createWalletSet(input: { name: string; idempotencyKey: string }) {
    const existing = this.sets.get(input.idempotencyKey);
    if (existing !== undefined) return { id: existing };
    const id = `ws-${++this.n}`;
    this.sets.set(input.idempotencyKey, id);
    return { id };
  }
  async createWallets(input: { walletSetId: string; refIds: readonly string[]; idempotencyKey: string }) {
    const key = `${input.walletSetId}:${input.idempotencyKey}`;
    const existing = this.walletCalls.get(key);
    if (existing !== undefined) return existing;
    const wallets = input.refIds.map((refId, i) => ({ id: `w-${++this.n}`, address: `0x${String(this.n * 10 + i).padStart(40, "a")}`, refId }));
    this.walletCalls.set(key, wallets);
    return wallets;
  }
  async createContractExecution(input: CircleContractExecutionInput) {
    this.executions.push(input);
    return { id: `tx-${this.executions.length}`, state: "INITIATED" as const };
  }
  async getTransaction() {
    return this.tx;
  }
}

describe("CircleKeyProvisioner", () => {
  test("one wallet set per customer and three EOAs by refId; a retry returns the same wallets", async () => {
    const c = new FakeCircle();
    const p = new CircleKeyProvisioner(c);
    const a = await p.provision(CUSTOMER);
    const b = await p.provision(CUSTOMER);
    expect(b).toEqual(a);
    expect([...c.sets.keys()]).toEqual([CUSTOMER]);
    expect(new Set([a.registrar.address, a.model.address, a.rules.address]).size).toBe(3);
    expect(a.registrar.address).toMatch(/^0x[0-9a-f]{40}$/);
    const other = await p.provision("01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e70");
    expect(other.walletSetId).not.toBe(a.walletSetId);
  });

  test("missing or duplicate wallets fail", async () => {
    const c = new FakeCircle();
    c.createWallets = async () => [{ id: "w", address: `0x${"1".repeat(40)}`, refId: "registrar" }];
    await expect(new CircleKeyProvisioner(c).provision(CUSTOMER)).rejects.toThrow(/no model wallet/);
    c.createWallets = async (input) => input.refIds.map((refId) => ({ id: refId, address: `0x${"1".repeat(40)}`, refId }));
    await expect(new CircleKeyProvisioner(c).provision(CUSTOMER)).rejects.toThrow(/duplicate/);
  });

  test("deterministicUuid is stable and UUID-shaped", () => {
    expect(deterministicUuid("x")).toBe(deterministicUuid("x"));
    expect(deterministicUuid("x")).not.toBe(deterministicUuid("y"));
    expect(deterministicUuid("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("CircleChainWriter", () => {
  const req = (call: WriteRequest["call"]): WriteRequest => ({
    policyWallet: WALLET,
    call,
    signer: { address: `0x${"2".repeat(40)}`, circleWalletId: "w-rules" },
    idempotencyKey: "key-1",
    refId: "intent-1",
  });

  test("sends contractExecution with the ABI signature, string params, fee level and idempotency key", async () => {
    const c = new FakeCircle();
    const w = new CircleChainWriter(c, { feeLevel: "HIGH" });
    expect(await w.send(req({ fn: "register", counterparty: CP, limit: 100_000_000n, recordHash: HASH }))).toEqual({ txId: "tx-1" });
    await w.send(req({ fn: "tighten", counterparty: CP, limit: 5n, expectedEpoch: 2n, recordHash: HASH }));
    await w.send(req({ fn: "pin", counterparty: CP, recordHash: HASH }));
    expect(c.executions).toEqual([
      {
        walletId: "w-rules",
        contractAddress: WALLET,
        abiFunctionSignature: "register(address,uint256,bytes32)",
        abiParameters: [CP, "100000000", HASH],
        feeLevel: "HIGH",
        idempotencyKey: "key-1",
        refId: "intent-1",
      },
      expect.objectContaining({ abiFunctionSignature: "tighten(address,uint256,uint256,bytes32)", abiParameters: [CP, "5", "2", HASH] }),
      expect.objectContaining({ abiFunctionSignature: "pin(address,bytes32)", abiParameters: [CP, HASH] }),
    ]);
  });

  test("a signer without a Circle wallet id is rejected", async () => {
    const w = new CircleChainWriter(new FakeCircle());
    await expect(w.send({ ...req({ fn: "pin", counterparty: CP, recordHash: HASH }), signer: { address: CP } })).rejects.toThrow(/wallet id/);
  });

  test("status mapping", async () => {
    const c = new FakeCircle();
    const w = new CircleChainWriter(c);
    const cases: [CircleTransaction, unknown][] = [
      [{ state: "QUEUED" }, { state: "pending" }],
      [{ state: "CONFIRMED", txHash: HASH }, { state: "pending" }],
      [{ state: "COMPLETE", txHash: HASH.toUpperCase().replace("0X", "0x") }, { state: "complete", txHash: HASH }],
      [{ state: "COMPLETE" }, { state: "pending" }],
      [{ state: "FAILED", errorReason: "EXECUTION_REVERTED" }, { state: "failed", error: "EXECUTION_REVERTED" }],
      [{ state: "STUCK" }, { state: "pending" }],
      [{ state: "DENIED" }, { state: "denied", error: "DENIED" }],
      [{ state: "CANCELLED" }, { state: "cancelled", error: "CANCELLED" }],
    ];
    for (const [tx, want] of cases) {
      c.tx = tx;
      expect(await w.status("tx-1")).toEqual(want);
    }
  });
});
