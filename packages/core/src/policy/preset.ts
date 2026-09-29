// Policy Presets (FR-13). Money is bigint USDC base units (6 dp); the threshold is integer basis points.
import { fromBaseUnits, toBaseUnits, type OffchainPolicy, type RiskTier } from "@horos/schema";

/** 1 USDC in base units. */
const USDC = 1_000_000n;

/** Tier Ceilings in USDC base units. */
export interface CoreTierCeilings {
  readonly low: bigint;
  readonly elevated: bigint;
  readonly high: bigint;
  readonly severe: bigint;
}

/** The off-chain part of a Policy, in core form. */
export interface CoreOffchainPolicy {
  readonly tierCeilings: CoreTierCeilings;
  /** Auto-decide threshold as integer basis points in [0, 10000] (7000 = 0.7). Never a float. */
  readonly autoDecideThresholdBps: number;
  readonly missingIdentityThreshold: bigint;
  readonly missingIdentityCeiling: bigint;
  readonly questionSetVersion: string;
  readonly judge: string;
  readonly noHistoryTier: RiskTier;
}

/** The on-chain part of a Policy (written to PolicyWallet; read-only here). */
export interface OnchainPolicy {
  readonly firstContactCeiling: bigint;
  readonly walletPeriodCap: bigint;
  readonly newPayeeCap: number;
  readonly policyPeriodDays: number;
}

export interface Preset {
  readonly version: string;
  readonly onchain: OnchainPolicy;
  readonly offchain: CoreOffchainPolicy;
}

/** The standard Preset, `standard@1`. */
export const STANDARD_PRESET: Preset = Object.freeze({
  version: "standard@1",
  onchain: Object.freeze({
    firstContactCeiling: 500n * USDC,
    walletPeriodCap: 5_000n * USDC,
    newPayeeCap: 10,
    policyPeriodDays: 30,
  }),
  offchain: Object.freeze({
    tierCeilings: Object.freeze({ low: 500n * USDC, elevated: 100n * USDC, high: 0n, severe: 0n }),
    autoDecideThresholdBps: 7_000,
    missingIdentityThreshold: 100n * USDC,
    missingIdentityCeiling: 100n * USDC,
    questionSetVersion: "v1",
    judge: "jev-1.13.0",
    noHistoryTier: "elevated",
  }),
});

/** Every known Preset by version string. */
export const PRESETS: Readonly<Record<string, Preset>> = Object.freeze({
  [STANDARD_PRESET.version]: STANDARD_PRESET,
});

/** Look up a Preset by version (own keys only). */
export function findPreset(version: string): Preset | undefined {
  return Object.hasOwn(PRESETS, version) ? PRESETS[version] : undefined;
}

const BPS_SCALE = 10_000;
const THRESHOLD_RE = /^(0\.[0-9]{4}|1\.0000)$/;

/** "0.7000" → 7000. Throws on anything but a 4-dp string in [0, 1]. */
export function thresholdToBps(threshold: string): number {
  if (!THRESHOLD_RE.test(threshold)) throw new RangeError("threshold must be a 4-dp string in [0, 1]");
  const [whole = "0", frac = "0000"] = threshold.split(".");
  return Number(whole) * BPS_SCALE + Number(frac);
}

/** 7000 → "0.7000". Throws unless an integer in [0, 10000]. */
export function bpsToThreshold(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_SCALE) throw new RangeError("bps must be an integer in [0, 10000]");
  return `${Math.floor(bps / BPS_SCALE)}.${String(bps % BPS_SCALE).padStart(4, "0")}`;
}

/** Core form → schema (storage/wire) form. */
export function toOffchainPolicy(p: CoreOffchainPolicy): OffchainPolicy {
  return {
    tierCeilings: {
      low: toBaseUnits(p.tierCeilings.low),
      elevated: toBaseUnits(p.tierCeilings.elevated),
      high: toBaseUnits(p.tierCeilings.high),
      severe: toBaseUnits(p.tierCeilings.severe),
    },
    autoDecideThreshold: bpsToThreshold(p.autoDecideThresholdBps),
    missingIdentityThreshold: toBaseUnits(p.missingIdentityThreshold),
    missingIdentityCeiling: toBaseUnits(p.missingIdentityCeiling),
    questionSetVersion: p.questionSetVersion,
    judge: p.judge,
    noHistoryTier: p.noHistoryTier,
  };
}

/** Schema (storage/wire) form → core form. Throws on malformed amounts or threshold. */
export function fromOffchainPolicy(p: OffchainPolicy): CoreOffchainPolicy {
  return {
    tierCeilings: {
      low: fromBaseUnits(p.tierCeilings.low),
      elevated: fromBaseUnits(p.tierCeilings.elevated),
      high: fromBaseUnits(p.tierCeilings.high),
      severe: fromBaseUnits(p.tierCeilings.severe),
    },
    autoDecideThresholdBps: thresholdToBps(p.autoDecideThreshold),
    missingIdentityThreshold: fromBaseUnits(p.missingIdentityThreshold),
    missingIdentityCeiling: fromBaseUnits(p.missingIdentityCeiling),
    questionSetVersion: p.questionSetVersion,
    judge: p.judge,
    noHistoryTier: p.noHistoryTier,
  };
}
