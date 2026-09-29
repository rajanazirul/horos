// Hard Rules stage (FR-4, AD-2): exact, case-insensitive address match against each list snapshot.
// Deterministic, never probabilistic. A match contributes `severe` and a Target Limit ceiling of 0.
import type { HardRuleResult } from "@horos/schema";
import type { HardRuleStageOutcome, ListSnapshot } from "./types.js";

/** The rule id recorded for every list check. */
export const EXACT_ADDRESS_RULE = "exact-address-match";

/** 24 hours in ms: an OFAC SDN list verified longer ago than this is stale. */
export const SDN_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

/**
 * True when no `ofac-sdn` snapshot is supplied or every one is older than 24h. A non-finite
 * `lastVerifiedAt` counts as stale (fail closed).
 */
export function isSdnStale(lists: readonly ListSnapshot[], now: number): boolean {
  const sdn = lists.filter((l) => l.source === "ofac-sdn");
  if (sdn.length === 0) return true;
  return sdn.every((l) => !Number.isFinite(l.lastVerifiedAt) || now - l.lastVerifiedAt > SDN_STALE_AFTER_MS);
}

/** True when no `ofac-sdn` snapshot is supplied at all. */
export function isSdnMissing(lists: readonly ListSnapshot[]): boolean {
  return !lists.some((l) => l.source === "ofac-sdn");
}

// Lowercase view of each snapshot's entries, memoised per entries object, so a checksummed or
// upper-case key can never make the exact-match rule fail open.
const lowercaseViews = new WeakMap<ReadonlyMap<string, readonly string[]>, ReadonlyMap<string, readonly string[]>>();

function lowercaseEntries(entries: ReadonlyMap<string, readonly string[]>): ReadonlyMap<string, readonly string[]> {
  const cached = lowercaseViews.get(entries);
  if (cached !== undefined) return cached;
  const view = new Map<string, readonly string[]>();
  for (const [key, names] of entries) {
    const k = key.toLowerCase();
    const prev = view.get(k);
    view.set(k, prev === undefined ? names : [...new Set([...prev, ...names])]);
  }
  lowercaseViews.set(entries, view);
  return view;
}

export function evaluateHardRules(
  counterparty: string,
  lists: readonly ListSnapshot[],
  now: number,
): HardRuleStageOutcome {
  if (!ADDRESS_RE.test(counterparty)) throw new RangeError("counterparty must be 0x followed by 40 hex characters");
  const address = counterparty.toLowerCase();
  const evidence: HardRuleResult[] = lists.map((list) => {
    const names = lowercaseEntries(list.entries).get(address);
    const base = {
      rule: EXACT_ADDRESS_RULE,
      source: list.source,
      snapshotId: list.snapshotId,
      snapshotHash: list.snapshotHash,
    };
    return names === undefined
      ? { ...base, matched: false }
      : { ...base, matched: true, entityNames: [...names] };
  });
  const matched = evidence.some((e) => e.matched);
  return matched
    ? { stage: "hard-rules", tierContribution: "severe", ceiling: 0n, evidence, matched, sdnStale: isSdnStale(lists, now) }
    : { stage: "hard-rules", tierContribution: "low", evidence, matched, sdnStale: isSdnStale(lists, now) };
}
