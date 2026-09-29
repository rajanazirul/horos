// Monotonicity (FR-8), determinism and never-raise properties over generated inputs.
import type { Decision, RiskTier } from "@horos/schema";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { STANDARD_PRESET, type CoreOffchainPolicy } from "../policy/preset.js";
import { isTighterOrEqual, TIER_ORDER, tierRank } from "../policy/tighter.js";
import { evaluate } from "./evaluate.js";
import { DEMO_ADDR, HOUR, NOW, OTHER, PAYEE, SDN_ADDR, demoList, omitKey, sdnList, u, withoutIdentity } from "./fixtures.test-helpers.js";
import { identityKeys } from "./identity.js";
import { isKnownPayeeNewAddress } from "./signals.js";
import type { ChainInput, Evaluation, EvaluationInput, JudgmentAnswer } from "./types.js";

const tierArb = fc.constantFrom<RiskTier>(...TIER_ORDER);
const money = (max: number) => fc.bigInt({ min: 0n, max: u(max) });

const policyArb: fc.Arbitrary<CoreOffchainPolicy> = fc.record({
  tierCeilings: fc.record({ low: money(600), elevated: money(600), high: money(50), severe: money(10) }),
  autoDecideThresholdBps: fc.integer({ min: 0, max: 10_000 }),
  missingIdentityThreshold: money(300),
  missingIdentityCeiling: money(300),
  questionSetVersion: fc.constant("v1"),
  judge: fc.constant(STANDARD_PRESET.offchain.judge),
  noHistoryTier: tierArb,
});

const chainArb: fc.Arbitrary<ChainInput> = fc
  .record({
    registered: fc.boolean(),
    limit: money(600),
    spentFrac: fc.integer({ min: 0, max: 100 }),
    walletRemaining: fc.oneof(fc.constant(0n), money(6_000)),
    newPayeeRemaining: fc.bigInt({ min: 0n, max: 3n }),
    pinned: fc.boolean(),
    humanSet: fc.boolean(),
    humanEpoch: fc.bigInt({ min: 0n, max: 5n }),
    payeeIsContract: fc.boolean(),
    firstContactCeiling: money(600),
  })
  .map((c) => ({
    view: {
      registered: c.registered,
      limit: c.registered ? c.limit : 0n,
      cpRemaining: c.registered ? (c.limit * BigInt(c.spentFrac)) / 100n : 0n,
      walletRemaining: c.walletRemaining,
      newPayeeRemaining: c.newPayeeRemaining,
      pinned: c.registered && c.pinned,
      humanSet: c.registered && c.humanSet,
      humanEpoch: c.humanEpoch,
    },
    payeeIsContract: c.payeeIsContract,
    firstContactCeiling: c.firstContactCeiling,
  }));

const answerArb: fc.Arbitrary<JudgmentAnswer> = fc.record({
  questionId: fc.constantFrom("q1", "q2", "q3"),
  tierContribution: tierArb,
  flippedTierContribution: tierArb,
  confidenceBps: fc.integer({ min: 0, max: 10_000 }),
});

const identityArb = fc.option(
  fc.constantFrom({ name: "Acme Data, Inc." }, { domain: "www.acme.example" }, { name: "Beta LLC", domain: "beta.example" }),
  { nil: undefined },
);

const inputArb: fc.Arbitrary<EvaluationInput> = fc
  .record({
    counterparty: fc.constantFrom(PAYEE, PAYEE, PAYEE, SDN_ADDR, SDN_ADDR.toUpperCase().replace("0X", "0x"), DEMO_ADDR),
    amount: fc.bigInt({ min: 1n, max: u(1_000) }),
    identity: identityArb,
    sdnAgeHours: fc.integer({ min: 0, max: 48 }),
    chain: fc.option(chainArb, { nil: undefined, freq: 8 }),
    chainState: fc.constantFrom("live" as const, "stale" as const),
    hasHistory: fc.boolean(),
    bindings: fc.subarray(["name:acme data", "domain:acme.example", "name:beta", "domain:beta.example"]),
    bindingAddress: fc.constantFrom(PAYEE, OTHER),
    exposure: fc.option(fc.record({ tierContribution: tierArb, inboundOnly: fc.boolean() }), { nil: undefined }),
    judgment: fc.option(fc.array(answerArb, { maxLength: 3 }), { nil: undefined }),
    pendingIntentTarget: fc.option(money(600), { nil: undefined }),
    policy: fc.oneof(fc.constant(STANDARD_PRESET.offchain), policyArb),
  })
  .map((g) => {
    const input: EvaluationInput = {
      counterparty: g.counterparty,
      amount: g.amount,
      now: NOW,
      lists: [sdnList(NOW - g.sdnAgeHours * HOUR), demoList()],
      chainState: g.chainState,
      hasHistory: g.hasHistory,
      identityBindings: g.bindings.map((key) => ({ key, address: g.bindingAddress })),
      policy: g.policy,
      ...(g.identity === undefined ? {} : { declaredIdentity: g.identity }),
      ...(g.chain === undefined ? {} : { chain: g.chain }),
      ...(g.exposure === undefined ? {} : { exposure: g.exposure }),
      ...(g.judgment === undefined ? {} : { judgment: g.judgment }),
      ...(g.pendingIntentTarget === undefined ? {} : { pendingIntentTarget: g.pendingIntentTarget }),
    };
    return input;
  });

const DECISION_RANK: Record<Decision, number> = { allow: 0, cap: 1, hold: 2, block: 3 };

/** `worse` is at least as tight as `base`: tier, Decision and (within the same Decision) target/payable. */
function expectNotLooser(base: Evaluation, worse: Evaluation): void {
  expect(tierRank(worse.riskTier)).toBeGreaterThanOrEqual(tierRank(base.riskTier));
  expect(DECISION_RANK[worse.decision]).toBeGreaterThanOrEqual(DECISION_RANK[base.decision]);
  if (worse.decision === base.decision) {
    expect(worse.targetLimit <= base.targetLimit).toBe(true);
    expect(worse.remaining <= base.remaining).toBe(true);
    if (worse.payable !== undefined && base.payable !== undefined) expect(worse.payable <= base.payable).toBe(true);
  }
}

const RUNS = { numRuns: 1_000 };

describe("monotonicity (FR-8)", () => {
  test("adding a risk signal never loosens", () => {
    const signalArb = fc.oneof(
      fc.constant({ kind: "no-history" as const }),
      fc.constant({ kind: "known-payee" as const }),
      fc.record({ kind: fc.constant("exposure" as const), tier: tierArb, inboundOnly: fc.boolean() }),
      fc.constant({ kind: "hard-rule" as const }),
    );
    fc.assert(
      fc.property(inputArb, signalArb, (input, sig) => {
        let worse: EvaluationInput;
        switch (sig.kind) {
          case "no-history":
            worse = { ...input, hasHistory: false };
            break;
          case "known-payee": {
            const keys = identityKeys(input.declaredIdentity);
            worse = { ...input, identityBindings: [...input.identityBindings, ...keys.map((key) => ({ key, address: OTHER }))] };
            break;
          }
          case "exposure": {
            const prev = input.exposure;
            // Worse: a more severe tier, or the same tier no longer inbound-only.
            const tier = prev === undefined || tierRank(sig.tier) >= tierRank(prev.tierContribution) ? sig.tier : prev.tierContribution;
            const inboundOnly = prev === undefined ? sig.inboundOnly : prev.inboundOnly && sig.inboundOnly;
            worse = { ...input, exposure: { tierContribution: tier, inboundOnly } };
            break;
          }
          case "hard-rule":
            // Moving to a listed address may drop other signals, but the Hard Rule block dominates.
            worse = { ...input, counterparty: SDN_ADDR };
            break;
        }
        expectNotLooser(evaluate(input), evaluate(worse));
      }),
      RUNS,
    );
  });

  test("worsening a judgment answer never loosens", () => {
    fc.assert(
      fc.property(inputArb, fc.nat(), tierArb, (input, pick, tier) => {
        const answers = input.judgment ?? [];
        if (answers.length === 0) return;
        const i = pick % answers.length;
        const a = answers[i] as JudgmentAnswer;
        if (tierRank(tier) <= tierRank(a.tierContribution)) return;
        // The answer moves to a worse outcome; the alternative is where it was.
        const moved: JudgmentAnswer = { ...a, tierContribution: tier, flippedTierContribution: a.tierContribution };
        const worse = { ...input, judgment: answers.map((x, j) => (j === i ? moved : x)) };
        expectNotLooser(evaluate(input), evaluate(worse));
      }),
      RUNS,
    );
  });

  test("removing identity above the missing-identity threshold never loosens", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        if (input.declaredIdentity === undefined) return;
        if (input.amount <= input.policy.missingIdentityThreshold) return;
        // Without an identity the known-payee signal cannot fire; that signal is covered by its own property.
        if (isKnownPayeeNewAddress(input)) return;
        expectNotLooser(evaluate(input), evaluate(withoutIdentity(input)));
      }),
      RUNS,
    );
  });

  test("a tighter-or-equal Policy change never loosens", () => {
    const lower = (v: bigint, frac: number): bigint => (v * BigInt(frac)) / 100n;
    const tightenArb = fc.record({
      low: fc.integer({ min: 0, max: 100 }),
      elevated: fc.integer({ min: 0, max: 100 }),
      high: fc.integer({ min: 0, max: 100 }),
      severe: fc.integer({ min: 0, max: 100 }),
      threshold: fc.integer({ min: 0, max: 10_000 }),
      missingThreshold: fc.integer({ min: 0, max: 100 }),
      missingCeiling: fc.integer({ min: 0, max: 100 }),
      noHistoryTier: tierArb,
    });
    fc.assert(
      fc.property(inputArb, tightenArb, (input, t) => {
        const p = input.policy;
        const next: CoreOffchainPolicy = {
          ...p,
          tierCeilings: {
            low: lower(p.tierCeilings.low, t.low),
            elevated: lower(p.tierCeilings.elevated, t.elevated),
            high: lower(p.tierCeilings.high, t.high),
            severe: lower(p.tierCeilings.severe, t.severe),
          },
          autoDecideThresholdBps: Math.max(p.autoDecideThresholdBps, t.threshold),
          missingIdentityThreshold: lower(p.missingIdentityThreshold, t.missingThreshold),
          missingIdentityCeiling: lower(p.missingIdentityCeiling, t.missingCeiling),
          noHistoryTier: tierRank(t.noHistoryTier) > tierRank(p.noHistoryTier) ? t.noHistoryTier : p.noHistoryTier,
        };
        expect(isTighterOrEqual(p, next)).toBe(true);
        expectNotLooser(evaluate(input), evaluate({ ...input, policy: next }));
      }),
      RUNS,
    );
  });

  test("lowering any confidence never loosens", () => {
    fc.assert(
      fc.property(inputArb, fc.nat(), fc.integer({ min: 0, max: 10_000 }), (input, pick, drop) => {
        const answers = input.judgment ?? [];
        if (answers.length === 0) return;
        const i = pick % answers.length;
        const worse = {
          ...input,
          judgment: answers.map((x, j) => (j === i ? { ...x, confidenceBps: Math.max(0, x.confidenceBps - drop) } : x)),
        };
        expectNotLooser(evaluate(input), evaluate(worse));
      }),
      RUNS,
    );
  });
});

describe("invariants", () => {
  test("deterministic: same input → deep-equal output", () => {
    fc.assert(fc.property(inputArb, (input) => {
      expect(evaluate(input)).toEqual(evaluate(input));
    }), RUNS);
  });

  test("never raises: target and intent never exceed the current Limit when registered; register ≤ FCC", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = evaluate(input);
        expect(r.targetLimit >= 0n).toBe(true);
        const chain = input.chain;
        if (chain?.view.registered === true) {
          expect(r.targetLimit <= chain.view.limit).toBe(true);
          if (r.outboxIntent !== undefined) {
            expect(r.outboxIntent.kind).not.toBe("register");
            expect(r.outboxIntent.target <= chain.view.limit).toBe(true);
            if (r.outboxIntent.kind === "tighten") expect(r.outboxIntent.target < chain.view.limit).toBe(true);
          }
        }
        if (r.outboxIntent?.kind === "register" && chain !== undefined) {
          expect(r.outboxIntent.target <= chain.firstContactCeiling).toBe(true);
        }
        if (input.chainState === "stale" && r.outboxIntent !== undefined) expect(r.outboxIntent.kind).toBe("pin");
        if (r.decision === "hold" || r.decision === "block") expect(r.targetLimit).toBe(0n);
        expect(r.payable !== undefined).toBe(r.decision === "cap");
        if (r.payable !== undefined) expect(r.payable < input.amount).toBe(true);
        if (r.decision === "allow") expect(r.remaining >= input.amount).toBe(true);
        expect(r.pinRequested).toBe(r.hardRules.some((h) => h.matched));
        if (r.pinRequested) expect(r.decision).toBe("block");
      }),
      RUNS,
    );
  });

  test("a Hard Rule match is always block, and judgment never changes the result", () => {
    fc.assert(
      fc.property(inputArb, fc.array(answerArb, { maxLength: 3 }), (input, answers) => {
        const matched = { ...input, counterparty: SDN_ADDR };
        const noJudgment = omitKey(matched, "judgment");
        const a = evaluate(noJudgment);
        const b = evaluate({ ...matched, judgment: answers });
        expect(b.decision).toBe("block");
        expect([b.riskTier, b.confidenceBps, b.reason]).toEqual([a.riskTier, a.confidenceBps, a.reason]);
      }),
      RUNS,
    );
  });
});
