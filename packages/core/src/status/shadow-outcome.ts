// Shadow Decision outcome label (Story 3.4, FR-28, AD-25). A shadow Decision is never "gated" or "caught": it is
// "would-have-caught" when Horos would have stopped a real payment (hold or block from a real signal, not a Horos Demo
// List simulation), and "advisory" otherwise. Pure; the summary endpoint counts the same rule in SQL.
import type { Decision, ShadowOutcome } from "@horos/schema";

/** The record fields the label depends on. */
export interface ShadowOutcomeInput {
  readonly scope: string;
  readonly decision: Decision;
  readonly simulated: boolean;
}

/** `"would-have-caught"` for a real (non-simulated) shadow hold/block, `"advisory"` for every other shadow record. */
export function shadowOutcome(record: ShadowOutcomeInput): ShadowOutcome {
  if (!record.scope.startsWith("shadow:")) throw new RangeError("shadowOutcome applies to shadow Scope records only");
  return (record.decision === "hold" || record.decision === "block") && !record.simulated ? "would-have-caught" : "advisory";
}

/**
 * Thrown inside a shadow record append when the Customer's PolicyWallet became bound after the pre-check: the whole
 * append rolls back and the Check answers `shadow_closed` (Story 3.4).
 */
export class ShadowClosedError extends Error {
  override readonly name = "ShadowClosedError";
  constructor(readonly customerId: string) {
    super("shadow mode is closed: the Customer's PolicyWallet is bound");
  }
}
