// Read-only Decision Record API responses (Story 2.8, FR-27, FR-29, AD-17, AD-19). Wire fields are camelCase,
// like the records they carry. Amounts are decimal strings of USDC base units.
import { z } from "zod";
import { ChainState } from "./check.js";
import { Address, Bytes32, UsdcAmount, UuidV7, WireTime } from "./primitives.js";
import { ScopeRecord } from "./record.js";

/** Largest page a read endpoint returns; the default is 50. */
export const READ_PAGE_MAX = 100;
export const READ_PAGE_DEFAULT = 50;

export const CounterpartyStatus = z.enum(["ok", "held", "blocked", "pinned"]);
export type CounterpartyStatus = z.output<typeof CounterpartyStatus>;

export const RecordEntry = z.strictObject({
  recordHash: Bytes32,
  record: ScopeRecord,
});
export type RecordEntry = z.output<typeof RecordEntry>;

/** `GET /v1/scopes/:scope/records`. `nextCursor` is the `after` of the next page (a seq), null at the end. */
export const RecordPage = z.strictObject({
  records: z.array(RecordEntry).max(READ_PAGE_MAX),
  nextCursor: z.int().nonnegative().nullable(),
});
export type RecordPage = z.output<typeof RecordPage>;

export const WriteReceiptStatus = z.enum(["confirmed", "noop", "superseded_by_human", "failed_terminal"]);
export type WriteReceiptStatus = z.output<typeof WriteReceiptStatus>;

/** A WriteReceipt: how one record's Limit write ended (AD-24). */
export const WriteReceiptView = z
  .strictObject({
    id: UuidV7,
    recordId: UuidV7,
    outboxIntentId: UuidV7,
    status: WriteReceiptStatus,
    /** Whether the outbox intent was a pin. */
    pin: z.boolean(),
    txHash: Bytes32.nullable(),
    onchainLimitAfter: UsdcAmount.nullable(),
    /** Decimal block number. */
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    createdAt: WireTime,
  })
  .refine((r) => r.status !== "confirmed" || (r.txHash !== null && r.onchainLimitAfter !== null && r.blockNumber !== null), {
    message: "a confirmed receipt carries txHash, onchainLimitAfter and blockNumber",
  });
export type WriteReceiptView = z.output<typeof WriteReceiptView>;

/** `GET /v1/scopes/:scope/records/:id`. */
export const RecordDetail = z.strictObject({
  recordHash: Bytes32,
  record: ScopeRecord,
  receipts: z.array(WriteReceiptView),
});
export type RecordDetail = z.output<typeof RecordDetail>;

/**
 * A Counterparty's status (AD-19). `chainState` is `live` when `pinned`/`limit` come from a live
 * `remaining(a)` read, `stale` when they come from the indexer mirror. `limit` is absent when unknown.
 */
export const CounterpartyStatusView = z.strictObject({
  counterparty: Address,
  status: CounterpartyStatus,
  /** The last record seq that fed the fold; null when none did. */
  lastSeq: z.int().nonnegative().nullable(),
  pinned: z.boolean(),
  limit: UsdcAmount.exactOptional(),
  chainState: ChainState,
});
export type CounterpartyStatusView = z.output<typeof CounterpartyStatusView>;

/** `GET /v1/scopes/:scope/counterparties`. `nextCursor` is the `after` of the next page (an address). */
export const CounterpartyStatusPage = z.strictObject({
  counterparties: z.array(CounterpartyStatusView).max(READ_PAGE_MAX),
  nextCursor: Address.nullable(),
});
export type CounterpartyStatusPage = z.output<typeof CounterpartyStatusPage>;
