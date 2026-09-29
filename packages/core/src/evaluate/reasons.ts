// Reason templates (FR-2). One sentence for the decisive rule or signal plus one for the Policy
// rule. Never model text; Declared Identity is always quoted, truncated and labelled "(unverified)";
// no compliance claims. 1–3 sentences, at most 600 characters.
import type { DeclaredIdentity, HardRuleResult, ListSource, RiskTier } from "@horos/schema";
import { SDN_STALE_AFTER_MS } from "./hard-rules.js";
import { identityKeys, normaliseDomain, normaliseName } from "./identity.js";
import type { DecisiveRule, IdentityBinding } from "./types.js";

export const REASON_MAX_CHARS = 600;
export const IDENTITY_QUOTE_MAX_CHARS = 60;

/** Words a reason must never contain (case-insensitive, also as substrings). */
export const BANNED_REASON_WORDS: readonly string[] = Object.freeze([
  "compliant",
  "compliance",
  "approved",
  "cleared",
  "safe",
  "guarantee",
]);

const BANNED_RE = new RegExp(BANNED_REASON_WORDS.join("|"), "giu");
const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;

/** Base units → "100" / "12.5" (trailing zeros trimmed). */
export function formatUsdc(amount: bigint): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / USDC_SCALE;
  const frac = (abs % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), "0").replace(/0+$/u, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac.length > 0 ? `.${frac}` : ""}`;
}

/** 7000 → "0.7000". */
export function formatBps(bps: number): string {
  return `${Math.floor(bps / 10_000)}.${String(bps % 10_000).padStart(4, "0")}`;
}

function maskBanned(s: string): string {
  let prev: string;
  let out = s;
  do {
    prev = out;
    out = out.replace(BANNED_RE, "…");
  } while (out !== prev);
  return out;
}

/** A Declared Identity value, cleaned, truncated to 60 chars, quoted and labelled "(unverified)". */
export function quoteUnverified(value: string): string {
  const cleaned = maskBanned(
    value
      .normalize("NFKC")
      .replace(/[\p{Cc}\p{Cf}"'`\\“”‘’]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  const chars = [...cleaned];
  const truncated = chars.length > IDENTITY_QUOTE_MAX_CHARS ? chars.slice(0, IDENTITY_QUOTE_MAX_CHARS).join("") : cleaned;
  return `"${truncated}" (unverified)`;
}

/** An external identifier (e.g. a snapshot id) reduced to a short, sentence-safe token. */
function token(s: string): string {
  return maskBanned(s.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 64)).replace(/\.+$/u, "");
}

const SOURCE_LABEL: Record<ListSource, string> = {
  "ofac-sdn": "OFAC SDN list",
  "horos-demo-list": "Horos Demo List (labelled test data)",
};

/** What pushed the Risk Tier to its value (first match in this order). */
export type TierDriver = "known-payee" | "exposure" | "judgment" | "no-history" | "none";

/** Which term set the Target Limit. */
export type TargetDriver = "missing-identity" | "tier-ceiling" | "first-contact-ceiling" | "pending-intent" | "onchain-limit";

export interface ReasonContext {
  readonly rule: DecisiveRule;
  readonly tier: RiskTier;
  readonly tierDriver: TierDriver;
  readonly targetDriver: TargetDriver;
  readonly confidenceBps: number;
  readonly thresholdBps: number;
  readonly amount: bigint;
  readonly remaining: bigint;
  readonly target: bigint;
  readonly missingIdentityThreshold: bigint;
  readonly matchedHardRule?: HardRuleResult;
  readonly declaredIdentity?: DeclaredIdentity;
  readonly identityBindings: readonly IdentityBinding[];
  readonly counterparty: string;
  readonly walletExhausted: boolean;
  readonly pinned: boolean;
  /** The current on-chain Limit when the Counterparty is registered. */
  readonly onchainLimit?: bigint;
  /** True when no OFAC SDN snapshot was supplied (vs. one that is too old). */
  readonly sdnMissing: boolean;
}

const SDN_STALE_AFTER_HOURS = SDN_STALE_AFTER_MS / (60 * 60 * 1000);

/** The Declared Identity field that is bound to a different address, quoted as unverified. */
function knownPayeeSubject(ctx: ReasonContext): string {
  const id = ctx.declaredIdentity;
  const address = ctx.counterparty.toLowerCase();
  const bound = new Set(ctx.identityBindings.filter((b) => b.address.toLowerCase() !== address).map((b) => b.key));
  if (id?.name !== undefined && bound.has(`name:${normaliseName(id.name)}`)) {
    return `The declared name ${quoteUnverified(id.name)}`;
  }
  if (id?.domain !== undefined && bound.has(`domain:${normaliseDomain(id.domain)}`)) {
    return `The declared domain ${quoteUnverified(id.domain)}`;
  }
  return identityKeys(id).length > 0 ? "The Declared Identity (unverified)" : "The Counterparty";
}

function tierSentence(ctx: ReasonContext): string {
  switch (ctx.tierDriver) {
    case "known-payee":
      return `${knownPayeeSubject(ctx)} is already bound to a different address in this Scope: known payee, new address.`;
    case "exposure":
      return `Exposure places the address in the ${ctx.tier} Risk Tier.`;
    case "judgment":
      return `Graded Judgment places the address in the ${ctx.tier} Risk Tier.`;
    case "no-history":
      return `The address has no prior history, which places it in the ${ctx.tier} Risk Tier.`;
    case "none":
      return `The address is in the ${ctx.tier} Risk Tier.`;
  }
}

function targetSentence(ctx: ReasonContext): string {
  const t = formatUsdc(ctx.target);
  switch (ctx.targetDriver) {
    case "missing-identity":
      return `No usable Declared Identity (name or domain) was supplied for an amount above ${formatUsdc(ctx.missingIdentityThreshold)} USDC, so the missing-identity ceiling of ${t} USDC applies.`;
    case "tier-ceiling":
      return ctx.tierDriver === "none"
        ? `The address is in the ${ctx.tier} Risk Tier, with a Tier Ceiling of ${t} USDC.`
        : `${tierSentence(ctx).slice(0, -1)}, with a Tier Ceiling of ${t} USDC.`;
    case "first-contact-ceiling":
      return `The First-Contact Ceiling of ${t} USDC applies to a new Counterparty.`;
    case "pending-intent":
      return `A pending Limit write already targets ${t} USDC.`;
    case "onchain-limit":
      return `The on-chain Limit for this Counterparty is ${t} USDC.`;
  }
}

export function buildReason(ctx: ReasonContext): string {
  const amount = formatUsdc(ctx.amount);
  const remaining = formatUsdc(ctx.remaining);
  let text: string;
  switch (ctx.rule) {
    case "hard-rule": {
      const hr = ctx.matchedHardRule;
      const list = hr === undefined ? "a Hard Rule list" : `the ${SOURCE_LABEL[hr.source]} (snapshot ${token(hr.snapshotId)})`;
      text = `The address exactly matches an entry on ${list}. Policy: a Hard Rule match blocks the payment and requests a pin of the Limit at 0.`;
      break;
    }
    case "severe-tier":
      text = `${tierSentence(ctx)} Policy: a severe Risk Tier blocks the payment.`;
      break;
    case "high-tier":
      text = `${tierSentence(ctx)} Policy: a high Risk Tier holds the payment for Policy Owner review.`;
      break;
    case "low-confidence":
      text = `Decision Confidence ${formatBps(ctx.confidenceBps)} is below the auto-decide threshold ${formatBps(ctx.thresholdBps)}. Policy: low confidence holds the payment for Policy Owner review.`;
      break;
    case "chain-unavailable":
      text = "The on-chain Limit could not be read from the chain or the indexer mirror. Policy: chain state unavailable, so the payment is held.";
      break;
    case "sanctions-list-stale":
      text = ctx.sdnMissing
        ? "No OFAC SDN list snapshot is available. Policy: sanctions list stale, so a first-contact payment is held."
        : `The OFAC SDN list was last verified more than ${SDN_STALE_AFTER_HOURS} hours ago. Policy: sanctions list stale, so a first-contact payment is held.`;
      break;
    case "new-payee-cap":
      text = "The wallet has registered its maximum number of new payees this period. Policy: new-payee cap reached, so a first-contact payment is held.";
      break;
    case "contract-payee":
      text = "The payee address is a contract. Policy: contract payee: Human registration required.";
      break;
    case "awaiting-review":
      text = "The on-chain Limit for this Counterparty is 0. Policy: awaiting Policy Owner review, so the payment is held.";
      break;
    case "human-block":
      text = "The Policy Owner set this Counterparty's Limit to 0. Policy: blocked by Policy Owner.";
      break;
    case "within-limit":
      text = `${targetSentence(ctx)} Policy: ${amount} USDC is within the ${remaining} USDC remaining, so the payment is allowed.`;
      break;
    case "partial":
      text = `${targetSentence(ctx)} Policy: only ${remaining} of the ${amount} USDC requested is payable, so the payment is capped.`;
      break;
    case "budget-used":
      text = ctx.walletExhausted
        ? "The wallet has no budget left in this Policy Period. Policy: budget used this period, so nothing more is payable now."
        : ctx.onchainLimit !== undefined && ctx.target < ctx.onchainLimit
          ? `This Counterparty's Limit is being tightened from ${formatUsdc(ctx.onchainLimit)} to ${formatUsdc(ctx.target)} USDC, and its spend in this Policy Period already uses that budget. Policy: budget used this period, so nothing more is payable now.`
          : `This Counterparty has used its ${formatUsdc(ctx.target)} USDC Limit in this Policy Period. Policy: budget used this period, so nothing more is payable now.`;
      break;
    case "zero-target":
      text = ctx.pinned
        ? "The on-chain Limit for this Counterparty is pinned at 0. Policy: a zero Limit holds the payment."
        : `${targetSentence(ctx)} Policy: a zero Limit holds the payment.`;
      break;
  }
  return text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS - 1)}…` : text;
}

/** A custom-error name reduced to a sentence-safe token (`"unknown"` when empty). */
function errorToken(name: string): string {
  const t = token(name);
  return t.length > 0 ? t : "unknown";
}

/** Correcting-record reason for a Limit write that failed terminally (Story 2.6). */
export function writeFailedReason(errorName: string): string {
  return `Horos could not write the Limit on-chain (${errorToken(errorName)}); payments to this counterparty are held until a new Check succeeds.`;
}

/** Correcting-record reason for a send-time Hard Rule match (Story 2.6), in the `hard-rule` template's words. */
export function sendTimeHardRuleReason(matched: HardRuleResult | undefined): string {
  const list = matched === undefined ? "a Hard Rule list" : `the ${SOURCE_LABEL[matched.source]} (snapshot ${token(matched.snapshotId)})`;
  return `The address exactly matches an entry on ${list}, found when the Limit write was about to be sent. Policy: a Hard Rule match blocks the payment and requests a pin of the Limit at 0.`;
}
