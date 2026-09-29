// Risk Tier helpers (FR-8). The tier is always the worst contribution.
import type { RiskTier } from "@horos/schema";
import type { CoreTierCeilings } from "../policy/preset.js";
import { TIER_ORDER, tierRank } from "../policy/tighter.js";

/** The most severe of the given tiers (`low` when empty). */
export function worstTier(tiers: Iterable<RiskTier>): RiskTier {
  let worst: RiskTier = "low";
  for (const t of tiers) if (tierRank(t) > tierRank(worst)) worst = t;
  return worst;
}

/** `tier`, but no more severe than `max`. */
export function clampTier(tier: RiskTier, max: RiskTier): RiskTier {
  return tierRank(tier) > tierRank(max) ? max : tier;
}

/**
 * Effective Tier Ceiling of `tier`: the min of its Tier Ceiling and every less severe tier's, so a
 * worse tier can never get a looser ceiling even when a tighter-only Policy change lowers `low`
 * below `elevated` (FR-8; resolves the Story 2.2 deferral).
 */
export function effectiveTierCeiling(ceilings: CoreTierCeilings, tier: RiskTier): bigint {
  const rank = tierRank(tier);
  let min = ceilings.low;
  for (const t of TIER_ORDER.slice(0, rank + 1)) if (ceilings[t] < min) min = ceilings[t];
  return min;
}
