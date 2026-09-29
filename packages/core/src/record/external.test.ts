import { EXTERNAL_RECORD_REASON, ExternalRecord, recordHash, ZERO_BYTES32, type Hex } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { buildExternalRecord, type ExternalRecordContext } from "./external.js";

const ZOD_ERROR = expect.objectContaining({ name: "ZodError" });
const CP = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
const H = (c: string): Hex => `0x${c.repeat(64)}`;

const ctx = (over: Partial<ExternalRecordContext> = {}): ExternalRecordContext => ({
  id: "01926f3a-8000-7000-8000-000000000009",
  scope: "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80",
  createdAt: "2026-09-28T12:05:00.000Z",
  customerId: "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f",
  policyWallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
  actor: "human",
  actorAddress: "0x2546bcd3c84621e976d8185a91a922ae77ecec30",
  txHash: H("a"),
  blockNumber: 1204n,
  blockTimestamp: "2026-09-28T12:04:58.000Z",
  carriedHash: H("7"),
  events: [
    { logIndex: 3, name: "CounterpartyRegistered", args: { counterparty: CP, limit: "300", recordHash: H("7") } },
    { logIndex: 4, name: "LimitSet", args: { counterparty: CP, oldLimit: "0", newLimit: "300", humanEpoch: "1", recordHash: H("7") } },
  ],
  ...over,
});

describe("buildExternalRecord", () => {
  test("builds a strict external record with the fixed reason, derived counterparty and no evaluation fields", () => {
    const r = buildExternalRecord(ctx(), 2, H("2"));
    expect(ExternalRecord.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      recordType: "external",
      seq: 2,
      prevHash: H("2"),
      blockNumber: 1204,
      counterparty: CP,
      reason: EXTERNAL_RECORD_REASON,
      simulated: false,
      advisory: false,
    });
    expect(r.reason).toBe("Observed on-chain; Horos did not originate or evaluate this change.");
    expect(r).not.toHaveProperty("decision");
    expect(recordHash(r)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("omits counterparty when an event has none", () => {
    const r = buildExternalRecord(
      ctx({ events: [{ logIndex: 0, name: "PolicyChanged", args: { field: "0", oldValue: "1", newValue: "2", recordHash: ZERO_BYTES32 } }], carriedHash: ZERO_BYTES32 }),
      0,
      ZERO_BYTES32,
    );
    expect(r).not.toHaveProperty("counterparty");
  });

  test("rejects an invalid combination (Human-only event from Rules)", () => {
    expect(() => buildExternalRecord(ctx({ actor: "rules" }), 1, H("1"))).toThrow(ZOD_ERROR);
  });

  test("rejects a block number beyond the safe integer range", () => {
    expect(() => buildExternalRecord(ctx({ blockNumber: 2n ** 60n }), 1, H("1"))).toThrow(RangeError);
  });
});
