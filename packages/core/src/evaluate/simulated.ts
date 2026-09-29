// `simulated` provenance (AD-10): a Decision touched by the Horos Demo List is simulated. The record
// builder (Story 2.5) derives `simulated` with this helper; callers never pass it.
import type { HardRuleResult } from "@horos/schema";

/** The list source whose matches make a Decision simulated. */
export const DEMO_LIST_SOURCE = "horos-demo-list";

/** True when any matched Hard Rule came from the Horos Demo List. */
export function isSimulated(evaluation: { readonly hardRules: readonly HardRuleResult[] }): boolean {
  return evaluation.hardRules.some((r) => r.matched && r.source === DEMO_LIST_SOURCE);
}
