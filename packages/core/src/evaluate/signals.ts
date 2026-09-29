// Deterministic Signals stage (FR-6, AD-2). All arithmetic in code. Evidence order is fixed:
// no-history, known-payee-new-address, missing-identity, then exposure (only when supplied).
import type { SignalResult } from "@horos/schema";
import { identityKeys } from "./identity.js";
import { clampTier, worstTier } from "./tier.js";
import type { EvaluationInput, SignalStageOutcome } from "./types.js";

export const SIGNAL_IDS = Object.freeze({
  noHistory: "no-history",
  knownPayeeNewAddress: "known-payee-new-address",
  missingIdentity: "missing-identity",
  exposure: "exposure",
} as const);

/** True when a normalised name/domain of the Declared Identity is bound to another address. */
export function isKnownPayeeNewAddress(input: Pick<EvaluationInput, "counterparty" | "declaredIdentity" | "identityBindings">): boolean {
  const keys = new Set(identityKeys(input.declaredIdentity));
  if (keys.size === 0) return false;
  const address = input.counterparty.toLowerCase();
  return input.identityBindings.some((b) => keys.has(b.key) && b.address.toLowerCase() !== address);
}

export function evaluateSignals(input: EvaluationInput): SignalStageOutcome {
  const { policy } = input;
  const evidence: SignalResult[] = [];

  const noHistory = !input.hasHistory;
  evidence.push({ id: SIGNAL_IDS.noHistory, value: noHistory, tierContribution: noHistory ? policy.noHistoryTier : "low" });

  const knownPayee = isKnownPayeeNewAddress(input);
  evidence.push({ id: SIGNAL_IDS.knownPayeeNewAddress, value: knownPayee, tierContribution: knownPayee ? "high" : "low" });

  // An identity with no usable name or domain counts as missing.
  const missingIdentity = identityKeys(input.declaredIdentity).length === 0 && input.amount > policy.missingIdentityThreshold;
  evidence.push({ id: SIGNAL_IDS.missingIdentity, value: missingIdentity, tierContribution: "low" });

  if (input.exposure !== undefined) {
    const { tierContribution, inboundOnly } = input.exposure;
    // Inbound-only exposure is clamped to `high` (hold at most) and never pins (AD-2).
    evidence.push({
      id: SIGNAL_IDS.exposure,
      value: inboundOnly ? "inbound" : "outbound",
      tierContribution: inboundOnly ? clampTier(tierContribution, "high") : tierContribution,
    });
  }

  const tierContribution = worstTier(evidence.map((e) => e.tierContribution));
  return missingIdentity
    ? { stage: "signals", tierContribution, ceiling: policy.missingIdentityCeiling, evidence }
    : { stage: "signals", tierContribution, evidence };
}
