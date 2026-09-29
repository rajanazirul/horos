import { describe, expect, test } from "vitest";
import { STANDARD_PRESET } from "../policy/preset.js";
import { evaluate } from "./evaluate.js";
import {
  DEMO_ADDR,
  HOUR,
  IDENTITY,
  NOW,
  OTHER,
  PAYEE,
  SDN_ADDR,
  baseInput,
  chainOf,
  demoList,
  firstContactView,
  omitKey,
  registeredView,
  sdnList,
  u,
  withoutIdentity,
} from "./fixtures.test-helpers.js";
import { identityKeys } from "./identity.js";
import type { EvaluationInput } from "./types.js";

const acmeBoundElsewhere = identityKeys(IDENTITY).map((key) => ({ key, address: OTHER }));

describe("worked examples (standard Preset)", () => {
  test("W1 new, small: allow; elevated; target 100; register 100", () => {
    const r = evaluate(baseInput({ amount: u(50) }));
    expect(r.decision).toBe("allow");
    expect(r.riskTier).toBe("elevated");
    expect(r.targetLimit).toBe(u(100));
    expect(r.remaining).toBe(u(100));
    expect(r.confidenceBps).toBe(10_000);
    expect(r.outboxIntent).toEqual({ kind: "register", target: u(100) });
    expect(r.payable).toBeUndefined();
    expect(r.decisiveRule).toBe("within-limit");
    expect(r.pinRequested).toBe(false);
  });

  test("W2 new, large: cap; payable 100; register 100", () => {
    const r = evaluate(baseInput({ amount: u(150) }));
    expect(r.decision).toBe("cap");
    expect(r.payable).toBe(u(100));
    expect(r.outboxIntent).toEqual({ kind: "register", target: u(100) });
  });

  test("W3 no identity: cap 100 via the missing-identity ceiling", () => {
    const r = evaluate(withoutIdentity(baseInput({ amount: u(150) })));
    expect(r.decision).toBe("cap");
    expect(r.payable).toBe(u(100));
    expect(r.targetLimit).toBe(u(100));
    expect(r.signals.find((s) => s.id === "missing-identity")?.value).toBe(true);
    expect(r.stages[1].ceiling).toBe(u(100));
    expect(r.reason).toContain("missing-identity ceiling");
  });

  test("W4 known good: allow; target 100; no intent", () => {
    const r = evaluate(baseInput({ amount: u(80), hasHistory: true, chain: chainOf(registeredView(u(100), u(100))) }));
    expect(r.decision).toBe("allow");
    expect(r.riskTier).toBe("low");
    expect(r.targetLimit).toBe(u(100));
    expect(r.outboxIntent).toBeUndefined();
  });

  test("W5 spent: cap 0 'budget used this period'", () => {
    const r = evaluate(baseInput({ amount: u(10), hasHistory: true, chain: chainOf(registeredView(u(100), 0n)) }));
    expect(r.decision).toBe("cap");
    expect(r.payable).toBe(0n);
    expect(r.decisiveRule).toBe("budget-used");
    expect(r.reason).toContain("budget used this period");
    expect(r.outboxIntent).toBeUndefined();
  });

  test.each([SDN_ADDR, SDN_ADDR.toUpperCase().replace("0X", "0x"), `0x${SDN_ADDR.slice(2).toUpperCase()}`])(
    "W6 OFAC match (%s): block; pin; evidence has entity names and snapshot id",
    (counterparty) => {
      const r = evaluate(baseInput({ counterparty }));
      expect(r.decision).toBe("block");
      expect(r.riskTier).toBe("severe");
      expect(r.pinRequested).toBe(true);
      expect(r.targetLimit).toBe(0n);
      expect(r.outboxIntent).toEqual({ kind: "pin", target: 0n });
      const hit = r.hardRules.find((h) => h.matched);
      expect(hit).toEqual({
        rule: "exact-address-match",
        source: "ofac-sdn",
        snapshotId: "sdn-2026-09-26T00",
        snapshotHash: `0x${"a".repeat(64)}`,
        matched: true,
        entityNames: ["EXAMPLE SANCTIONED ENTITY", "EXAMPLE ALIAS"],
      });
      expect(r.hardRules.find((h) => h.source === "horos-demo-list")?.matched).toBe(false);
      expect(r.reason).toContain("OFAC SDN");
    },
  );

  test("W7 known payee, new address: hold; tighten to 0", () => {
    const r = evaluate(
      baseInput({ hasHistory: true, identityBindings: acmeBoundElsewhere, chain: chainOf(registeredView(u(100), u(100))) }),
    );
    expect(r.decision).toBe("hold");
    expect(r.riskTier).toBe("high");
    expect(r.reason).toContain("known payee, new address");
    expect(r.reason).toContain("(unverified)");
    expect(r.outboxIntent).toEqual({ kind: "tighten", target: 0n, humanEpoch: 3n });
  });
});

describe("I/O matrix edge cases", () => {
  test("stale list on first contact: hold 'sanctions list stale'; register 0", () => {
    const r = evaluate(baseInput({ lists: [sdnList(NOW - 25 * HOUR)] }));
    expect(r.decision).toBe("hold");
    expect(r.decisiveRule).toBe("sanctions-list-stale");
    expect(r.reason).toContain("sanctions list stale");
    expect(r.outboxIntent).toEqual({ kind: "register", target: 0n });
  });

  test("exactly 24h old is not stale", () => {
    expect(evaluate(baseInput({ lists: [sdnList(NOW - 24 * HOUR)] })).decision).toBe("allow");
  });

  test("missing SDN list fails closed on first contact", () => {
    expect(evaluate(baseInput({ lists: [] })).decisiveRule).toBe("sanctions-list-stale");
  });

  test("a stale Demo List alone does not trigger the stale rule", () => {
    const demo = { ...sdnList(), source: "horos-demo-list" as const, lastVerifiedAt: NOW - 100 * HOUR };
    expect(evaluate(baseInput({ lists: [sdnList(), demo] })).decision).toBe("allow");
  });

  test("stale list does not affect a registered Counterparty", () => {
    const r = evaluate(baseInput({ hasHistory: true, lists: [sdnList(NOW - 25 * HOUR)], chain: chainOf(registeredView(u(100), u(100))) }));
    expect(r.decision).toBe("allow");
  });

  test("chain down, no mirror: hold 'chain state unavailable'; no intent", () => {
    const rest = omitKey(baseInput(), "chain");
    const r = evaluate({ ...rest, chainState: "stale" });
    expect(r.decision).toBe("hold");
    expect(r.reason).toContain("chain state unavailable");
    expect(r.outboxIntent).toBeUndefined();
    expect(r.targetLimit).toBe(0n);
  });

  test("chain down, no mirror, Hard Rule match: block with only a pin intent", () => {
    const rest = omitKey(baseInput({ counterparty: SDN_ADDR }), "chain");
    const r = evaluate({ ...rest, chainState: "stale" });
    expect(r.decision).toBe("block");
    expect(r.outboxIntent).toEqual({ kind: "pin", target: 0n });
  });

  test("chain stale with a mirror view: evaluates normally but emits no register/tighten", () => {
    const r = evaluate(baseInput({ chainState: "stale" }));
    expect(r.decision).toBe("allow");
    expect(r.outboxIntent).toBeUndefined();
    const t = evaluate(
      baseInput({ chainState: "stale", hasHistory: true, identityBindings: acmeBoundElsewhere, chain: chainOf(registeredView(u(100), u(100))) }),
    );
    expect(t.decision).toBe("hold");
    expect(t.outboxIntent).toBeUndefined();
  });

  test("inbound-only severe exposure: tier high; hold; no pin", () => {
    const r = evaluate(baseInput({ exposure: { tierContribution: "severe", inboundOnly: true } }));
    expect(r.riskTier).toBe("high");
    expect(r.decision).toBe("hold");
    expect(r.pinRequested).toBe(false);
    expect(r.outboxIntent).toEqual({ kind: "register", target: 0n });
    expect(r.signals.at(-1)).toEqual({ id: "exposure", value: "inbound", tierContribution: "high" });
  });

  test("outbound severe exposure passes through: block, no pin", () => {
    const r = evaluate(baseInput({ exposure: { tierContribution: "severe", inboundOnly: false } }));
    expect(r.riskTier).toBe("severe");
    expect(r.decision).toBe("block");
    expect(r.decisiveRule).toBe("severe-tier");
    expect(r.pinRequested).toBe(false);
  });

  test("Horos Demo List match runs the same Hard Rule", () => {
    const r = evaluate(baseInput({ counterparty: DEMO_ADDR }));
    expect(r.decision).toBe("block");
    expect(r.hardRules.find((h) => h.matched)?.source).toBe("horos-demo-list");
    expect(r.reason).toContain("Horos Demo List");
  });
});

describe("truth table rows (AD-2a)", () => {
  const registered = (limit: bigint, cp: bigint, patch = {}): EvaluationInput =>
    baseInput({ hasHistory: true, chain: chainOf(registeredView(limit, cp, patch)) });

  test("row 1: Hard Rule → block", () => {
    expect(evaluate(baseInput({ counterparty: SDN_ADDR })).decisiveRule).toBe("hard-rule");
  });

  test("row 2: severe → block", () => {
    const r = evaluate(baseInput({ judgment: [{ questionId: "q", tierContribution: "severe", flippedTierContribution: "low", confidenceBps: 9_000 }] }));
    expect([r.decision, r.decisiveRule]).toEqual(["block", "severe-tier"]);
    expect(r.targetLimit).toBe(0n);
  });

  test("row 3: high → hold", () => {
    const r = evaluate(baseInput({ identityBindings: acmeBoundElsewhere }));
    expect([r.decision, r.decisiveRule]).toEqual(["hold", "high-tier"]);
  });

  test("row 3: Confidence below threshold → hold", () => {
    const r = evaluate(
      baseInput({ judgment: [{ questionId: "q", tierContribution: "elevated", flippedTierContribution: "low", confidenceBps: 6_999 }] }),
    );
    expect([r.decision, r.decisiveRule, r.confidenceBps]).toEqual(["hold", "low-confidence", 6_999]);
    expect(r.reason).toContain("0.6999");
  });

  test("row 3: Confidence at threshold does not hold; no counted answer → 10000", () => {
    const at = evaluate(baseInput({ judgment: [{ questionId: "q", tierContribution: "low", flippedTierContribution: "elevated", confidenceBps: 7_000 }] }));
    expect([at.decision, at.confidenceBps]).toEqual(["allow", 7_000]);
    const none = evaluate(baseInput({ judgment: [{ questionId: "q", tierContribution: "low", flippedTierContribution: "low", confidenceBps: 1 }] }));
    expect(none.confidenceBps).toBe(10_000);
  });

  test("row 3a: stale list on first contact → hold", () => {
    expect(evaluate(baseInput({ lists: [sdnList(NOW - 25 * HOUR)] })).decisiveRule).toBe("sanctions-list-stale");
  });

  test("row 3b: first contact and newPayeeRemaining 0 → hold 'new-payee cap reached'; register 0", () => {
    const r = evaluate(baseInput({ chain: chainOf(firstContactView({ newPayeeRemaining: 0n })) }));
    expect([r.decision, r.decisiveRule]).toEqual(["hold", "new-payee-cap"]);
    expect(r.reason).toContain("new-payee cap reached");
    expect(r.outboxIntent).toEqual({ kind: "register", target: 0n });
  });

  test("row 3c: first contact with a contract payee → hold; no intent", () => {
    const r = evaluate(baseInput({ chain: chainOf(firstContactView(), { payeeIsContract: true }) }));
    expect([r.decision, r.decisiveRule]).toEqual(["hold", "contract-payee"]);
    expect(r.reason).toContain("contract payee: Human registration required");
    expect(r.outboxIntent).toBeUndefined();
  });

  test("row 3d: registered at 0, not pinned, not Human-set → hold 'awaiting Policy Owner review'", () => {
    const r = evaluate(registered(0n, 0n));
    expect([r.decision, r.decisiveRule]).toEqual(["hold", "awaiting-review"]);
    expect(r.reason).toContain("awaiting Policy Owner review");
    expect(r.outboxIntent).toBeUndefined();
  });

  test("row 3e: Human-set Limit 0 → block 'blocked by Policy Owner'", () => {
    const r = evaluate(registered(0n, 0n, { humanSet: true }));
    expect([r.decision, r.decisiveRule]).toEqual(["block", "human-block"]);
    expect(r.reason).toContain("blocked by Policy Owner");
    expect(r.pinRequested).toBe(false);
  });

  test("row 7: pinned at 0 (not Human-set) → hold 'a zero Limit holds the payment'", () => {
    const r = evaluate(registered(0n, 0n, { pinned: true }));
    expect([r.decision, r.decisiveRule]).toEqual(["hold", "zero-target"]);
    expect(r.reason).toContain("pinned");
    expect(r.reason).toContain("a zero Limit holds the payment");
  });

  test("row 4: remaining ≥ amount → allow", () => {
    const r = evaluate({ ...registered(u(100), u(100)), amount: u(100) });
    expect([r.decision, r.remaining]).toEqual(["allow", u(100)]);
  });

  test("row 5: 0 < remaining < amount → cap (payable = remaining)", () => {
    const r = evaluate({ ...registered(u(100), u(40)), amount: u(50) });
    expect([r.decision, r.payable, r.decisiveRule]).toEqual(["cap", u(40), "partial"]);
  });

  test("row 6: wallet cap exhausted → cap 0", () => {
    const r = evaluate(baseInput({ chain: chainOf(firstContactView({ walletRemaining: 0n })) }));
    expect([r.decision, r.payable, r.decisiveRule]).toEqual(["cap", 0n, "budget-used"]);
    expect(r.reason).toContain("budget used this period");
  });

  test("remaining on a registered Counterparty subtracts the tightening from cpRemaining", () => {
    // Limit 500, 300 left; tier elevated (no history) → target 100 → remaining max(0, 300 − 400) = 0 → spent.
    const r = evaluate(baseInput({ amount: u(10), chain: chainOf(registeredView(u(500), u(300))) }));
    expect(r.targetLimit).toBe(u(100));
    expect([r.decision, r.payable]).toEqual(["cap", 0n]);
    expect(r.outboxIntent).toEqual({ kind: "tighten", target: u(100), humanEpoch: 3n });
    const r2 = evaluate(baseInput({ amount: u(10), chain: chainOf(registeredView(u(500), u(450))) }));
    expect([r2.decision, r2.remaining]).toEqual(["allow", u(50)]);
  });

  test("row 7: Policy ceiling 0 on first contact → hold 'a zero Limit holds the payment'; register 0", () => {
    const policy = { ...STANDARD_PRESET.offchain, missingIdentityCeiling: 0n };
    const r = evaluate(withoutIdentity(baseInput({ amount: u(150), policy })));
    expect([r.decision, r.decisiveRule]).toEqual(["hold", "zero-target"]);
    expect(r.reason).toContain("a zero Limit holds the payment");
    expect(r.outboxIntent).toEqual({ kind: "register", target: 0n });
  });
});

describe("Target Limit", () => {
  test("pending-intent target and live FCC bound it", () => {
    expect(evaluate(baseInput({ pendingIntentTarget: u(30), amount: u(50) })).payable).toBe(u(30));
    const fcc = evaluate(baseInput({ hasHistory: true, chain: chainOf(firstContactView(), { firstContactCeiling: u(20) }), amount: u(50) }));
    expect([fcc.targetLimit, fcc.payable]).toEqual([u(20), u(20)]);
    expect(fcc.outboxIntent).toEqual({ kind: "register", target: u(20) });
  });

  test("effective Tier Ceiling is monotone even when low < elevated", () => {
    const policy = { ...STANDARD_PRESET.offchain, tierCeilings: { ...STANDARD_PRESET.offchain.tierCeilings, low: u(10) } };
    const r = evaluate(baseInput({ policy, amount: u(50) }));
    expect(r.riskTier).toBe("elevated");
    expect(r.targetLimit).toBe(u(10));
  });

  test("never above the on-chain Limit; never a tighten at or above it", () => {
    const r = evaluate(baseInput({ hasHistory: true, chain: chainOf(registeredView(u(40), u(40))), amount: u(10) }));
    expect(r.targetLimit).toBe(u(40));
    expect(r.outboxIntent).toBeUndefined();
  });
});

describe("Hard Rule dominates judgment", () => {
  test("judgment input does not influence tier, confidence or reason on a match", () => {
    const plain = evaluate(baseInput({ counterparty: SDN_ADDR }));
    const withJudgment = evaluate(
      baseInput({
        counterparty: SDN_ADDR,
        judgment: [
          { questionId: "q1", tierContribution: "low", flippedTierContribution: "severe", confidenceBps: 1 },
          { questionId: "q2", tierContribution: "elevated", flippedTierContribution: "low", confidenceBps: 0 },
        ],
      }),
    );
    expect(withJudgment.decision).toBe("block");
    expect(withJudgment.riskTier).toBe(plain.riskTier);
    expect(withJudgment.confidenceBps).toBe(10_000);
    expect(withJudgment.reason).toBe(plain.reason);
    expect(withJudgment.stages[2]).toEqual({ stage: "judgment", tierContribution: "low", evidence: [], skipped: true });
  });
});

describe("evidence and validation", () => {
  test("signals are in fixed order", () => {
    const r = evaluate(baseInput({ exposure: { tierContribution: "low", inboundOnly: false } }));
    expect(r.signals.map((s) => s.id)).toEqual(["no-history", "known-payee-new-address", "missing-identity", "exposure"]);
    expect(r.stages.map((s) => s.stage)).toEqual(["hard-rules", "signals", "judgment"]);
  });

  test("a binding to the same address is not a known-payee-new-address", () => {
    const same = identityKeys(IDENTITY).map((key) => ({ key, address: PAYEE.toUpperCase().replace("0X", "0x") }));
    expect(evaluate(baseInput({ identityBindings: same })).riskTier).toBe("elevated");
  });

  test("rejects a non-positive amount and bad confidence", () => {
    expect(() => evaluate(baseInput({ amount: 0n }))).toThrow(RangeError);
    expect(() =>
      evaluate(baseInput({ judgment: [{ questionId: "q", tierContribution: "low", flippedTierContribution: "low", confidenceBps: 0.5 }] })),
    ).toThrow(RangeError);
  });

  test("does not mutate its input", () => {
    const input = baseInput({ counterparty: SDN_ADDR });
    evaluate(input);
    expect(input).toEqual(baseInput({ counterparty: SDN_ADDR }));
    expect(input.lists[0]?.entries.get(SDN_ADDR)).toEqual(["EXAMPLE SANCTIONED ENTITY", "EXAMPLE ALIAS"]);
  });
});

describe("review fixes", () => {
  const CHECKSUMMED = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEF0003";

  test("a checksummed list key still blocks, for any counterparty casing", () => {
    const list = { ...sdnList(), entries: new Map([[CHECKSUMMED, ["CHECKSUMMED ENTITY"]]]) };
    for (const counterparty of [CHECKSUMMED, CHECKSUMMED.toLowerCase(), `0x${CHECKSUMMED.slice(2).toUpperCase()}`]) {
      const r = evaluate(baseInput({ counterparty, lists: [list] }));
      expect([r.decision, r.decisiveRule, r.pinRequested]).toEqual(["block", "hard-rule", true]);
      expect(r.hardRules[0]?.entityNames).toEqual(["CHECKSUMMED ENTITY"]);
    }
  });

  test.each(["", "0x123", "1111111111111111111111111111111111111111", `0x${"g".repeat(40)}`, `${PAYEE}0`, ` ${PAYEE}`])(
    "a malformed counterparty %j throws RangeError",
    (counterparty) => {
      expect(() => evaluate(baseInput({ counterparty }))).toThrow(RangeError);
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("SDN lastVerifiedAt %s counts as stale", (at) => {
    const r = evaluate(baseInput({ lists: [sdnList(at)] }));
    expect([r.decision, r.decisiveRule]).toEqual(["hold", "sanctions-list-stale"]);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("now = %s throws RangeError", (now) => {
    expect(() => evaluate(baseInput({ now }))).toThrow(RangeError);
  });

  test.each([{ purpose: "x" }, { name: "LLC" }, { name: "  ", domain: "https://" }])(
    "identity without a usable name/domain %j is capped at the missing-identity ceiling",
    (declaredIdentity) => {
      const r = evaluate(baseInput({ amount: u(150), hasHistory: true, declaredIdentity }));
      expect(r.signals.find((s) => s.id === "missing-identity")?.value).toBe(true);
      expect([r.decision, r.payable, r.targetLimit]).toEqual(["cap", u(100), u(100)]);
    },
  );

  test("budget used after a tightening names the on-chain Limit and the tightened target", () => {
    const r = evaluate(baseInput({ chain: chainOf(registeredView(u(500), u(100))) }));
    expect([r.decision, r.decisiveRule, r.payable]).toEqual(["cap", "budget-used", 0n]);
    expect(r.outboxIntent).toEqual({ kind: "tighten", target: u(100), humanEpoch: 3n });
    expect(r.reason).toContain("tightened from 500 to 100 USDC");
    expect(r.reason).toContain("budget used this period");
    expect(r.reason).not.toContain("has used its 100 USDC Limit");
  });

  test("a missing SDN list has its own stale reason; a stale one states the 24h window", () => {
    const missing = evaluate(baseInput({ lists: [demoList()] }));
    expect(missing.reason).toContain("No OFAC SDN list snapshot is available");
    expect(missing.reason).not.toContain("last verified");
    const stale = evaluate(baseInput({ lists: [sdnList(NOW - 25 * HOUR)] }));
    expect(stale.reason).toContain("more than 24 hours ago");
  });
});

describe("row 3e precedes row 3", () => {
  test("Human-set 0 stays block even when the tier is high", () => {
    const r = evaluate(
      baseInput({ identityBindings: identityKeys(IDENTITY).map((key) => ({ key, address: OTHER })), chain: chainOf(registeredView(0n, 0n, { humanSet: true })) }),
    );
    expect(r.riskTier).toBe("high");
    expect([r.decision, r.decisiveRule]).toEqual(["block", "human-block"]);
  });
});
