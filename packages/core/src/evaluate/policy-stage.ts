// Policy stage (AD-2, AD-2a): the only stage that combines outcomes. Risk Tier, Decision
// Confidence, Target Limit, the truth table (first match wins), the outbox intent and the reason.
import type { Decision } from "@horos/schema";
import { isSdnMissing } from "./hard-rules.js";
import { decisionConfidenceBps, FULL_CONFIDENCE_BPS } from "./judgment.js";
import { buildReason, type TargetDriver, type TierDriver } from "./reasons.js";
import { SIGNAL_IDS } from "./signals.js";
import { effectiveTierCeiling, worstTier } from "./tier.js";
import type {
  DecisiveRule,
  Evaluation,
  EvaluationInput,
  HardRuleStageOutcome,
  JudgmentStageOutcome,
  OutboxIntent,
  SignalStageOutcome,
} from "./types.js";

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

function tierDriverOf(tier: string, signals: SignalStageOutcome, judgment: JudgmentStageOutcome): TierDriver {
  const reaches = (id: string): boolean =>
    signals.evidence.some((s) => s.id === id && s.tierContribution === tier && s.value !== false);
  if (reaches(SIGNAL_IDS.knownPayeeNewAddress)) return "known-payee";
  if (reaches(SIGNAL_IDS.exposure)) return "exposure";
  if (judgment.tierContribution === tier && judgment.evidence.length > 0 && tier !== "low") return "judgment";
  if (reaches(SIGNAL_IDS.noHistory)) return "no-history";
  return "none";
}

export function policyStage(
  input: EvaluationInput,
  hardRules: HardRuleStageOutcome,
  signals: SignalStageOutcome,
  judgment: JudgmentStageOutcome,
): Evaluation {
  const { policy, amount } = input;
  const riskTier = worstTier([hardRules.tierContribution, signals.tierContribution, judgment.tierContribution]);
  const confidenceBps = hardRules.matched ? FULL_CONFIDENCE_BPS : decisionConfidenceBps(judgment);
  const chain = input.chain;
  const view = chain?.view;
  const firstContact = view !== undefined && !view.registered;

  // Target Limit = min of every ceiling that applies; each term is recorded so the reason can name it.
  const terms: [TargetDriver, bigint][] = [];
  if (signals.ceiling !== undefined) terms.push(["missing-identity", signals.ceiling]);
  terms.push(["tier-ceiling", effectiveTierCeiling(policy.tierCeilings, riskTier)]);
  if (input.pendingIntentTarget !== undefined) terms.push(["pending-intent", input.pendingIntentTarget]);
  if (chain !== undefined) terms.push(["first-contact-ceiling", chain.firstContactCeiling]);
  if (view?.registered === true) terms.push(["onchain-limit", view.limit]);
  if (hardRules.ceiling !== undefined) terms.push(["tier-ceiling", hardRules.ceiling]);
  if (judgment.ceiling !== undefined) terms.push(["tier-ceiling", judgment.ceiling]);
  let [targetDriver, computedTarget] = terms[0] ?? ["tier-ceiling", 0n];
  for (const [driver, value] of terms) {
    if (value < computedTarget) [targetDriver, computedTarget] = [driver, value];
  }
  computedTarget = maxBig(0n, computedTarget);

  const remainingFor = (target: bigint): bigint => {
    if (view === undefined || chain === undefined) return 0n;
    if (view.registered) {
      return minBig(view.walletRemaining, maxBig(0n, view.cpRemaining - (view.limit - target)));
    }
    return minBig(view.walletRemaining, minBig(target, chain.firstContactCeiling));
  };

  // AD-2a truth table as amended 2026-09-26, first match wins.
  let decision: Decision;
  let rule: DecisiveRule;
  if (hardRules.matched) [decision, rule] = ["block", "hard-rule"];
  else if (riskTier === "severe") [decision, rule] = ["block", "severe-tier"];
  // Row 3e precedes row 3 (AD-2a amendment): a Human-set 0 stays a block even when the tier is high,
  // so a worse tier can never loosen block → hold (FR-8).
  else if (view?.registered === true && view.limit === 0n && view.humanSet) [decision, rule] = ["block", "human-block"];
  else if (riskTier === "high") [decision, rule] = ["hold", "high-tier"];
  else if (confidenceBps < policy.autoDecideThresholdBps) [decision, rule] = ["hold", "low-confidence"];
  else if (view === undefined) [decision, rule] = ["hold", "chain-unavailable"];
  else if (firstContact && hardRules.sdnStale) [decision, rule] = ["hold", "sanctions-list-stale"];
  else if (firstContact && view.newPayeeRemaining <= 0n) [decision, rule] = ["hold", "new-payee-cap"];
  else if (firstContact && chain?.payeeIsContract === true) [decision, rule] = ["hold", "contract-payee"];
  else if (view.registered && view.limit === 0n && !view.pinned && !view.humanSet) [decision, rule] = ["hold", "awaiting-review"];
  else {
    const rem = remainingFor(computedTarget);
    if (rem >= amount) [decision, rule] = ["allow", "within-limit"];
    else if (rem > 0n) [decision, rule] = ["cap", "partial"];
    else if (view.walletRemaining <= 0n || (view.registered && view.limit > 0n && computedTarget > 0n)) {
      [decision, rule] = ["cap", "budget-used"];
    } else [decision, rule] = ["hold", "zero-target"]; // row 7
  }

  const holdOrBlock = decision === "hold" || decision === "block";
  const targetLimit = holdOrBlock ? 0n : computedTarget;
  const remaining = holdOrBlock ? 0n : remainingFor(targetLimit);

  // Outbox intent. Never a Raise: `tighten` only below the live Limit; `register` only on first contact.
  let outboxIntent: OutboxIntent | undefined;
  if (hardRules.matched) outboxIntent = { kind: "pin", target: 0n };
  else if (view !== undefined && chain !== undefined && input.chainState === "live") {
    if (firstContact) {
      if (!chain.payeeIsContract) outboxIntent = { kind: "register", target: minBig(targetLimit, chain.firstContactCeiling) };
    } else if (targetLimit < view.limit) {
      outboxIntent = { kind: "tighten", target: targetLimit, humanEpoch: view.humanEpoch };
    }
  }

  const matchedHardRule = hardRules.evidence.find((e) => e.matched);
  const reason = buildReason({
    rule,
    tier: riskTier,
    tierDriver: tierDriverOf(riskTier, signals, judgment),
    targetDriver,
    confidenceBps,
    thresholdBps: policy.autoDecideThresholdBps,
    amount,
    remaining,
    target: rule === "zero-target" ? 0n : targetLimit,
    missingIdentityThreshold: policy.missingIdentityThreshold,
    ...(matchedHardRule === undefined ? {} : { matchedHardRule }),
    ...(input.declaredIdentity === undefined ? {} : { declaredIdentity: input.declaredIdentity }),
    identityBindings: input.identityBindings,
    counterparty: input.counterparty,
    walletExhausted: view !== undefined && view.walletRemaining <= 0n,
    pinned: view?.pinned === true,
    ...(view?.registered === true ? { onchainLimit: view.limit } : {}),
    sdnMissing: isSdnMissing(input.lists),
  });

  return {
    decision,
    riskTier,
    confidenceBps,
    targetLimit,
    remaining,
    ...(decision === "cap" ? { payable: remaining } : {}),
    decisiveRule: rule,
    reason,
    pinRequested: hardRules.matched,
    ...(outboxIntent === undefined ? {} : { outboxIntent }),
    hardRules: hardRules.evidence,
    signals: signals.evidence,
    stages: [hardRules, signals, judgment],
  };
}
