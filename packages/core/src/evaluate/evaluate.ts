// Pure `evaluate()` (AD-1, AD-2): Hard Rules → Deterministic Signals → Graded Judgment input →
// Policy, in that fixed order. No I/O, clock or randomness; every fact is an argument.
import { evaluateHardRules } from "./hard-rules.js";
import { evaluateJudgment } from "./judgment.js";
import { policyStage } from "./policy-stage.js";
import { evaluateSignals } from "./signals.js";
import type { Evaluation, EvaluationInput } from "./types.js";

export function evaluate(input: EvaluationInput): Evaluation {
  if (input.amount <= 0n) throw new RangeError("amount must be positive base units");
  if (!Number.isFinite(input.now)) throw new RangeError("now must be a finite ms timestamp");
  const hardRules = evaluateHardRules(input.counterparty, input.lists, input.now);
  const signals = evaluateSignals(input);
  // A Hard Rule match is final: the Judge input is not consulted (FR-4).
  const judgment = evaluateJudgment(input.judgment, hardRules.matched);
  return policyStage(input, hardRules, signals, judgment);
}
