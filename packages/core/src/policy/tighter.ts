// Tighter-or-equal proof for off-chain Policy changes (FR-14, AD-14).
import type { RiskTier } from "@horos/schema";
import type { CoreOffchainPolicy } from "./preset.js";

/** Risk Tiers from least to most severe. */
export const TIER_ORDER: readonly RiskTier[] = Object.freeze(["low", "elevated", "high", "severe"]);

/** Severity rank of a tier (0 = low). */
export function tierRank(tier: RiskTier): number {
  const rank = TIER_ORDER.indexOf(tier);
  if (rank < 0) throw new RangeError(`unknown risk tier: ${String(tier)}`);
  return rank;
}

const TIERS = ["low", "elevated", "high", "severe"] as const;

/**
 * Every dimension in which `next` is looser than `prev` (or, for `judge` / `questionSetVersion`,
 * different: a swap is never provably tighter). Empty means `next` is tighter or equal.
 */
export function looserDimensions(prev: CoreOffchainPolicy, next: CoreOffchainPolicy): string[] {
  const out: string[] = [];
  for (const tier of TIERS) {
    if (next.tierCeilings[tier] > prev.tierCeilings[tier]) out.push(`tierCeilings.${tier}`);
  }
  if (next.autoDecideThresholdBps < prev.autoDecideThresholdBps) out.push("autoDecideThreshold");
  if (next.missingIdentityThreshold > prev.missingIdentityThreshold) out.push("missingIdentityThreshold");
  if (next.missingIdentityCeiling > prev.missingIdentityCeiling) out.push("missingIdentityCeiling");
  if (tierRank(next.noHistoryTier) < tierRank(prev.noHistoryTier)) out.push("noHistoryTier");
  if (next.judge !== prev.judge) out.push("judge");
  if (next.questionSetVersion !== prev.questionSetVersion) out.push("questionSetVersion");
  return out;
}

/** True only when `next` is tighter than or equal to `prev` in every off-chain dimension. */
export function isTighterOrEqual(prev: CoreOffchainPolicy, next: CoreOffchainPolicy): boolean {
  return looserDimensions(prev, next).length === 0;
}

/** Exact equality of two off-chain Policies. */
export function offchainPolicyEquals(a: CoreOffchainPolicy, b: CoreOffchainPolicy): boolean {
  return (
    TIERS.every((t) => a.tierCeilings[t] === b.tierCeilings[t]) &&
    a.autoDecideThresholdBps === b.autoDecideThresholdBps &&
    a.missingIdentityThreshold === b.missingIdentityThreshold &&
    a.missingIdentityCeiling === b.missingIdentityCeiling &&
    a.questionSetVersion === b.questionSetVersion &&
    a.judge === b.judge &&
    a.noHistoryTier === b.noHistoryTier
  );
}
