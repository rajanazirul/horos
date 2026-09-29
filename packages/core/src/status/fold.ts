// Counterparty status projection (AD-19, FR-27, FR-29): a pure fold over one enforced Scope's records for one
// Counterparty, their confirmed WriteReceipts and one chain fact (`pinned`). Advisory records never feed it;
// `held` and `blocked` are sticky against automated loosening; the chain's `pinned` always wins.
import type { ChainState, DecisionRecord, ExternalRecord } from "@horos/schema";

export type CounterpartyStatus = "ok" | "held" | "blocked" | "pinned";

/** The parts of a record the fold reads (a full `ScopeRecord` is assignable). */
export type StatusRecord =
  | Pick<DecisionRecord, "seq" | "decision" | "advisory">
  | Pick<ExternalRecord, "recordType" | "seq" | "actor" | "events">;

/**
 * One fold input, in `seq` order. A receipt carries its record's `seq` and sorts after that record. Only
 * `confirmed` receipts are fold inputs; `pin` is whether the receipt's outbox intent was a pin.
 */
export type StatusEntry =
  | { readonly kind: "record"; readonly seq: number; readonly record: StatusRecord }
  | { readonly kind: "receipt"; readonly seq: number; readonly pin: boolean };

/** The chain fact the fold consumes, plus provenance passed through to the result. */
export interface StatusChain {
  readonly pinned: boolean;
  /** The on-chain Limit, when known (live read or mirror row). */
  readonly limit?: bigint;
  readonly chainState: ChainState;
}

export interface StatusResult {
  readonly status: CounterpartyStatus;
  /** The highest `seq` among the entries that fed the fold (advisory records excluded), or null when none did. */
  readonly lastSeq: number | null;
  readonly pinned: boolean;
  readonly limit?: bigint;
  readonly chainState: ChainState;
}

type Folded = Exclude<CounterpartyStatus, "pinned">;

const tighten = (s: Folded, to: "held" | "blocked"): Folded => (to === "blocked" || s === "blocked" ? "blocked" : "held");

function isExternal(r: StatusRecord): r is Pick<ExternalRecord, "recordType" | "seq" | "actor" | "events"> {
  return "recordType" in r && r.recordType === "external";
}

function applyExternal(s: Folded, r: Pick<ExternalRecord, "actor" | "events">): Folded {
  if (r.actor === "pending-human") return s; // only OwnershipTransferred, never a Counterparty event
  if (r.actor !== "human") return tighten(s, "held"); // registrar / model / rules, or anything unknown: fail closed
  let out = s;
  for (const e of r.events) {
    if (e.name === "LimitSet") {
      const newLimit = e.args["newLimit"];
      out = newLimit !== undefined && /^[1-9][0-9]*$/.test(newLimit) ? "ok" : "blocked";
    } else if (e.name === "PinReleased") {
      out = "held";
    }
  }
  return out;
}

function apply(s: Folded, entry: StatusEntry): Folded {
  if (entry.kind === "receipt") return entry.pin ? "blocked" : s;
  const r = entry.record;
  if (isExternal(r)) return applyExternal(s, r);
  if (r.advisory) return s;
  switch (r.decision) {
    case "block":
      return "blocked";
    case "hold":
      return tighten(s, "held");
    case "allow":
    case "cap":
      return s;
    default:
      return tighten(s, "held"); // an unknown decision fails closed
  }
}

/** Whether `entry` feeds the fold (advisory DecisionRecords never do). */
const feeds = (entry: StatusEntry): boolean => entry.kind === "receipt" || isExternal(entry.record) || !entry.record.advisory;

/**
 * `ok | held | blocked | pinned` from `entries` (one enforced Scope, one Counterparty, `seq` order) and the
 * chain. Starts at `ok`; `allow`/`cap` never leave `held`/`blocked`; only a Human `setLimit` above 0 returns
 * to `ok`. Finally `chain.pinned` → `pinned`.
 */
export function foldStatus(entries: readonly StatusEntry[], chain: StatusChain): StatusResult {
  let s: Folded = "ok";
  let lastSeq: number | null = null;
  for (const e of entries) {
    if (!feeds(e)) continue;
    s = apply(s, e);
    if (lastSeq === null || e.seq > lastSeq) lastSeq = e.seq;
  }
  return {
    status: chain.pinned ? "pinned" : s,
    lastSeq,
    pinned: chain.pinned,
    ...(chain.limit === undefined ? {} : { limit: chain.limit }),
    chainState: chain.chainState,
  };
}

/** Merge a Counterparty's records and confirmed receipts into fold order: by seq, a record before its receipts. */
export function statusEntries(
  records: readonly { readonly seq: number; readonly record: StatusRecord }[],
  receipts: readonly { readonly seq: number; readonly pin: boolean }[],
): StatusEntry[] {
  const out: StatusEntry[] = [
    ...records.map((r) => ({ kind: "record" as const, seq: r.seq, record: r.record })),
    ...receipts.map((r) => ({ kind: "receipt" as const, seq: r.seq, pin: r.pin })),
  ];
  return out.sort((a, b) => a.seq - b.seq || (a.kind === b.kind ? 0 : a.kind === "record" ? -1 : 1));
}
