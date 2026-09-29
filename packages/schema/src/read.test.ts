import { describe, expect, test } from "vitest";
import { CounterpartyStatusPage, CounterpartyStatusView, READ_ACCESS_TYPES, readAccessMessage, RecordPage, WriteReceiptView } from "./index.js";

const H = (c: string) => `0x${c.repeat(64)}`;
const ID = "01926f3a-8000-7000-8000-000000000009";

describe("read API schemas", () => {
  test("ReadAccess type and message", () => {
    expect(READ_ACCESS_TYPES.ReadAccess.map((f) => `${f.type} ${f.name}`)).toEqual(["address policyWallet", "uint64 expiry"]);
    expect(readAccessMessage("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "2026-09-28T12:04:00.000Z")).toEqual({
      policyWallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
      expiry: BigInt(Date.parse("2026-09-28T12:04:00.000Z") / 1000),
    });
  });

  test("RecordPage: empty page and cursor", () => {
    expect(RecordPage.parse({ records: [], nextCursor: null })).toEqual({ records: [], nextCursor: null });
    expect(RecordPage.safeParse({ records: [], nextCursor: -1 }).success).toBe(false);
    expect(RecordPage.safeParse({ records: [], nextCursor: null, extra: 1 }).success).toBe(false);
  });

  test("WriteReceiptView: a confirmed receipt carries tx facts", () => {
    const base = { id: ID, recordId: ID, outboxIntentId: ID, pin: false, createdAt: "2026-09-28T12:00:00.000Z" };
    expect(WriteReceiptView.safeParse({ ...base, status: "noop", txHash: null, onchainLimitAfter: null, blockNumber: null }).success).toBe(true);
    expect(WriteReceiptView.safeParse({ ...base, status: "confirmed", txHash: null, onchainLimitAfter: null, blockNumber: null }).success).toBe(false);
    expect(WriteReceiptView.safeParse({ ...base, status: "confirmed", txHash: H("e"), onchainLimitAfter: "100", blockNumber: "50" }).success).toBe(true);
  });

  test("CounterpartyStatusView and page", () => {
    const v = { counterparty: "0x1111111111111111111111111111111111111111", status: "held", lastSeq: 3, pinned: false, chainState: "stale" };
    expect(CounterpartyStatusView.parse(v)).toEqual(v);
    expect(CounterpartyStatusView.safeParse({ ...v, status: "frozen" }).success).toBe(false);
    expect(CounterpartyStatusView.safeParse({ ...v, limit: "1.5" }).success).toBe(false);
    expect(CounterpartyStatusPage.parse({ counterparties: [v], nextCursor: null }).counterparties).toHaveLength(1);
  });
});
