// PolicyVersion activation rule (FR-13, FR-14, AD-14). Pure.
import type { CreatePolicyVersionRequest, PolicyActivation, PolicyVersion } from "@horos/schema";
import { findPreset, fromOffchainPolicy } from "./preset.js";
import { looserDimensions, offchainPolicyEquals } from "./tighter.js";

export type ActivationDecision =
  | { readonly ok: true; readonly activation: PolicyActivation; readonly seq: number; readonly parentId?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide whether `request` may become the next PolicyVersion of its scope without a Human signature.
 * - No active version: the policy must be an exact copy of the named Preset's off-chain values.
 * - Otherwise: same Preset lineage, and `isTighterOrEqual(active, next)`.
 */
export function decideActivation(
  active: Pick<PolicyVersion, "id" | "seq" | "presetVersion" | "policy"> | undefined,
  request: CreatePolicyVersionRequest,
): ActivationDecision {
  const next = fromOffchainPolicy(request.policy);
  if (active === undefined) {
    const preset = findPreset(request.presetVersion);
    if (preset === undefined) {
      return { ok: false, reason: `unknown preset ${request.presetVersion}; the first version must copy a known Preset` };
    }
    if (!offchainPolicyEquals(preset.offchain, next)) {
      return { ok: false, reason: `the first version must be an exact copy of preset ${preset.version}` };
    }
    return { ok: true, activation: "preset", seq: 1 };
  }
  if (request.presetVersion !== active.presetVersion) {
    return {
      ok: false,
      reason: `presetVersion ${request.presetVersion} does not match the active version's ${active.presetVersion}`,
    };
  }
  const looser = looserDimensions(fromOffchainPolicy(active.policy), next);
  if (looser.length > 0) {
    return { ok: false, reason: `not tighter or equal in: ${looser.join(", ")}; loosening needs a Human signature` };
  }
  return { ok: true, activation: "tighter-proof", seq: active.seq + 1, parentId: active.id };
}
