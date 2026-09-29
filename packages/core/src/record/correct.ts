// Correcting Decision Records (Story 2.6, AD-8). When an outbox write fails terminally, or a send-time
// Hard Rule re-check matches, the worker appends a new record to the intent's Scope that supersedes the
// Decision it could not enforce. Pure: `id`, `createdAt`, `seq` and `prevHash` arrive as arguments.
import { DecisionRecord, type HardRuleResult, type Hex } from "@horos/schema";
import { sendTimeHardRuleReason, writeFailedReason } from "../evaluate/reasons.js";
import { isSimulated } from "../evaluate/simulated.js";

export type CorrectionCause =
  | { readonly kind: "write-failed"; readonly error: string }
  | { readonly kind: "hard-rule"; readonly hardRules: readonly HardRuleResult[] };

/**
 * Copy `prior`'s context (Scope, Customer, wallet, Counterparty, amount, identity, signals, versions,
 * trigger) into a new `hold` (write failed; `block` when `prior` was a block) or `block` (Hard Rule) record
 * without a Target Limit.
 * `prior` is the record whose hash the failed intent would have sent. Throws `ZodError` when invalid.
 */
export function buildCorrectingRecord(
  prior: DecisionRecord,
  cause: CorrectionCause,
  id: string,
  createdAt: string,
  seq: number,
  prevHash: Hex,
): DecisionRecord {
  const { targetLimit: _dropped, ...context } = prior;
  void _dropped;
  const base = { ...context, id, createdAt, seq, prevHash };
  if (cause.kind === "write-failed") {
    // Never loosen: a prior `block` (e.g. a Hard Rule pin whose write failed) stays a block.
    return DecisionRecord.parse({ ...base, decision: prior.decision === "block" ? "block" : "hold", reason: writeFailedReason(cause.error) });
  }
  const hardRules = cause.hardRules.map((h) => ({ ...h }));
  const matched = hardRules.find((h) => h.matched);
  if (matched === undefined) throw new RangeError("a hard-rule correction needs a matched Hard Rule");
  return DecisionRecord.parse({
    ...base,
    hardRules,
    riskTier: "severe",
    confidence: "1.0000",
    decision: "block",
    reason: sendTimeHardRuleReason(matched),
    simulated: isSimulated({ hardRules }),
  });
}
