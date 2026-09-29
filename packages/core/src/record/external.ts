// Pure ExternalRecord builder (AD-9/AD-23/AD-24 amendment 2026-09-27). The Story 2.7 indexer calls it for a
// state-changing PolicyWallet transaction whose events resolve to no consistent record in the Scope. No
// evaluation: the record carries the observed facts only. `id` and `createdAt` arrive in the context.
import { EXTERNAL_RECORD_REASON, ExternalRecord, type ExternalActor, type ExternalEvent, type Hex, type Scope } from "@horos/schema";

export interface ExternalRecordContext {
  /** UUIDv7 minted by the caller. */
  readonly id: string;
  readonly scope: Scope;
  /** Wire time the record is written (indexing time). */
  readonly createdAt: string;
  readonly customerId: string;
  readonly policyWallet: string;
  readonly actor: ExternalActor;
  readonly actorAddress: string;
  readonly txHash: string;
  readonly blockNumber: bigint | number;
  /** Wire time of the block. */
  readonly blockTimestamp: string;
  /** The first unmatched event's recordHash (zero bytes for `UnpinRequested`). */
  readonly carriedHash: string;
  /** The transaction's unmatched events, in log order. */
  readonly events: readonly ExternalEvent[];
}

/**
 * Build the ExternalRecord at `(seq, prevHash)`. `counterparty` is derived: present iff every event carries
 * the same `counterparty` arg. Synchronous and pure. Throws `ZodError` when the result is invalid.
 */
export function buildExternalRecord(ctx: ExternalRecordContext, seq: number, prevHash: Hex): ExternalRecord {
  const events = ctx.events.map((e) => ({ logIndex: e.logIndex, name: e.name, args: { ...e.args } }));
  const cps = events.map((e) => e.args["counterparty"]);
  const first = cps[0];
  const counterparty = first !== undefined && cps.every((c) => c === first) ? first : undefined;
  const blockNumber = typeof ctx.blockNumber === "bigint" ? Number(ctx.blockNumber) : ctx.blockNumber;
  if (!Number.isSafeInteger(blockNumber)) throw new RangeError("blockNumber exceeds the safe integer range");
  return ExternalRecord.parse({
    schemaVersion: 1,
    recordType: "external",
    id: ctx.id,
    scope: ctx.scope,
    seq,
    prevHash,
    createdAt: ctx.createdAt,
    customerId: ctx.customerId,
    policyWallet: ctx.policyWallet,
    actor: ctx.actor,
    actorAddress: ctx.actorAddress,
    txHash: ctx.txHash,
    blockNumber,
    blockTimestamp: ctx.blockTimestamp,
    carriedHash: ctx.carriedHash,
    events,
    ...(counterparty === undefined ? {} : { counterparty }),
    reason: EXTERNAL_RECORD_REASON,
    simulated: false,
    advisory: false,
  });
}
