// Graded Judgment input stage (AD-2). Core never calls a Judge: answers arrive as arguments
// (Epic 4). A Hard Rule match skips this stage entirely, so judgment cannot touch a block.
import { worstTier } from "./tier.js";
import type { JudgmentAnswer, JudgmentEvidence, JudgmentStageOutcome } from "./types.js";

export const FULL_CONFIDENCE_BPS = 10_000;

/**
 * An answer counts toward Decision Confidence when its own flip would change that answer's tier
 * contribution (AD-2a amendment 2026-09-26, refining FR-8). This never yields a higher confidence
 * than the literal "flip changes the Risk Tier" rule, and unlike it, it is monotone: adding a
 * signal or worsening another answer can never make an uncertain answer stop counting.
 */
export function answerCounts(a: JudgmentAnswer): boolean {
  return a.flippedTierContribution !== a.tierContribution;
}

export function evaluateJudgment(answers: readonly JudgmentAnswer[] | undefined, skip: boolean): JudgmentStageOutcome {
  if (skip || answers === undefined) {
    return { stage: "judgment", tierContribution: "low", evidence: [], skipped: skip };
  }
  const evidence: JudgmentEvidence[] = answers.map((a) => {
    if (!Number.isInteger(a.confidenceBps) || a.confidenceBps < 0 || a.confidenceBps > FULL_CONFIDENCE_BPS) {
      throw new RangeError(`confidenceBps must be an integer in [0, 10000] (question ${a.questionId})`);
    }
    return {
      questionId: a.questionId,
      tierContribution: a.tierContribution,
      confidenceBps: a.confidenceBps,
      counted: answerCounts(a),
    };
  });
  return {
    stage: "judgment",
    tierContribution: worstTier(evidence.map((e) => e.tierContribution)),
    evidence,
    skipped: false,
  };
}

/** Lowest confidence among counted answers, or 10000 when none count. */
export function decisionConfidenceBps(stage: JudgmentStageOutcome): number {
  let min = FULL_CONFIDENCE_BPS;
  for (const e of stage.evidence) if (e.counted && e.confidenceBps < min) min = e.confidenceBps;
  return min;
}
