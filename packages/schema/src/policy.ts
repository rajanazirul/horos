// Off-chain Policy and PolicyVersion wire schema (FR-13, FR-14, AD-14). Record-style camelCase.
import { z } from "zod";
import { UsdcAmount, UuidV7, WireTime } from "./primitives.js";
import { RecordConfidence, RiskTier, Scope } from "./record.js";

/** `<name>@<n>`, e.g. `standard@1`. */
export const PresetVersion = z.string().regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/, "expected <name>@<n>, e.g. standard@1");
export type PresetVersion = z.output<typeof PresetVersion>;

/** Tier Ceilings per Risk Tier, as USDC base units. */
export const TierCeilings = z.strictObject({
  low: UsdcAmount,
  elevated: UsdcAmount,
  high: UsdcAmount,
  severe: UsdcAmount,
});
export type TierCeilings = z.output<typeof TierCeilings>;

/**
 * The off-chain part of a Policy. Strict. `autoDecideThreshold` is a fixed 4-dp string in [0, 1]
 * (same format as `RecordConfidence`) so JSON and hashes stay stable.
 */
export const OffchainPolicy = z.strictObject({
  tierCeilings: TierCeilings,
  autoDecideThreshold: RecordConfidence,
  missingIdentityThreshold: UsdcAmount,
  missingIdentityCeiling: UsdcAmount,
  questionSetVersion: z.string().min(1).max(64),
  judge: z.string().min(1).max(64),
  noHistoryTier: RiskTier,
});
export type OffchainPolicy = z.output<typeof OffchainPolicy>;

/** `POST /v1/policy-versions` request body. No signature fields: Human-signed activation is Epic 6. */
export const CreatePolicyVersionRequest = z.strictObject({
  scope: Scope,
  presetVersion: PresetVersion,
  policy: OffchainPolicy,
});
export type CreatePolicyVersionRequest = z.output<typeof CreatePolicyVersionRequest>;

export const PolicyActivation = z.enum(["preset", "tighter-proof"]);
export type PolicyActivation = z.output<typeof PolicyActivation>;

/** A stored, immutable PolicyVersion. The active version of a scope is the one with the highest `seq`. */
export const PolicyVersion = z.strictObject({
  id: UuidV7,
  scope: Scope,
  seq: z.int().min(1),
  parentId: UuidV7.exactOptional(),
  presetVersion: PresetVersion,
  activation: PolicyActivation,
  policy: OffchainPolicy,
  createdAt: WireTime,
});
export type PolicyVersion = z.output<typeof PolicyVersion>;
