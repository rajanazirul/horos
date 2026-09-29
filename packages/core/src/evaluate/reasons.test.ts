import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { STANDARD_PRESET } from "../policy/preset.js";
import { evaluate } from "./evaluate.js";
import {
  HOUR,
  IDENTITY,
  NOW,
  OTHER,
  SDN_ADDR,
  DEMO_ADDR,
  baseInput,
  chainOf,
  firstContactView,
  omitKey,
  registeredView,
  sdnList,
  u,
  withoutIdentity,
} from "./fixtures.test-helpers.js";
import { identityKeys } from "./identity.js";
import { BANNED_REASON_WORDS, formatBps, formatUsdc, quoteUnverified, REASON_MAX_CHARS } from "./reasons.js";
import type { DecisiveRule, EvaluationInput } from "./types.js";

/** Sentences outside quoted Declared Identity values. */
function sentenceCount(reason: string): number {
  return (reason.replace(/"[^"]*"/gu, "\"\"").match(/[.!?](?=\s|$)/gu) ?? []).length;
}

function expectWellFormed(reason: string): void {
  expect(reason.length).toBeGreaterThan(0);
  expect(reason.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
  const n = sentenceCount(reason);
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(3);
  const lower = reason.toLowerCase();
  for (const w of BANNED_REASON_WORDS) expect(lower).not.toContain(w);
  // Every quoted value is labelled unverified.
  for (const m of reason.matchAll(/"[^"]*"/gu)) {
    expect(reason.slice((m.index ?? 0) + m[0].length)).toMatch(/^ \(unverified\)/u);
  }
}

const bound = identityKeys(IDENTITY).map((key) => ({ key, address: OTHER }));
const reg = (limit: bigint, cp: bigint, patch = {}): EvaluationInput =>
  baseInput({ hasHistory: true, chain: chainOf(registeredView(limit, cp, patch)) });
const noChain = omitKey(baseInput(), "chain");

const EVERY_ROW: [DecisiveRule, EvaluationInput, string][] = [
  ["hard-rule", baseInput({ counterparty: SDN_ADDR }), "OFAC SDN list"],
  ["hard-rule", baseInput({ counterparty: DEMO_ADDR }), "Horos Demo List"],
  ["severe-tier", baseInput({ exposure: { tierContribution: "severe", inboundOnly: false } }), "Exposure"],
  ["severe-tier", baseInput({ judgment: [{ questionId: "q", tierContribution: "severe", flippedTierContribution: "low", confidenceBps: 9_000 }] }), "Graded Judgment"],
  ["high-tier", baseInput({ identityBindings: bound }), "known payee, new address"],
  ["high-tier", baseInput({ exposure: { tierContribution: "severe", inboundOnly: true } }), "Exposure"],
  ["high-tier", baseInput({ policy: { ...STANDARD_PRESET.offchain, noHistoryTier: "high" } }), "no prior history"],
  ["low-confidence", baseInput({ judgment: [{ questionId: "q", tierContribution: "low", flippedTierContribution: "high", confidenceBps: 10 }] }), "auto-decide threshold"],
  ["chain-unavailable", { ...noChain, chainState: "stale" }, "chain state unavailable"],
  ["sanctions-list-stale", baseInput({ lists: [sdnList(NOW - 30 * HOUR)] }), "sanctions list stale"],
  ["new-payee-cap", baseInput({ chain: chainOf(firstContactView({ newPayeeRemaining: 0n })) }), "new-payee cap reached"],
  ["contract-payee", baseInput({ chain: chainOf(firstContactView(), { payeeIsContract: true }) }), "contract payee: Human registration required"],
  ["awaiting-review", reg(0n, 0n), "awaiting Policy Owner review"],
  ["human-block", reg(0n, 0n, { humanSet: true }), "blocked by Policy Owner"],
  ["within-limit", baseInput(), "no prior history"],
  ["within-limit", reg(u(100), u(100)), "on-chain Limit"],
  ["within-limit", baseInput({ pendingIntentTarget: u(60) }), "pending"],
  ["within-limit", baseInput({ hasHistory: true, chain: chainOf(firstContactView(), { firstContactCeiling: u(60) }) }), "First-Contact Ceiling"],
  ["partial", baseInput({ amount: u(150) }), "Tier Ceiling of 100 USDC"],
  ["partial", withoutIdentity(baseInput({ amount: u(150), hasHistory: true })), "missing-identity ceiling"],
  ["budget-used", reg(u(100), 0n), "has used its 100 USDC Limit"],
  ["budget-used", baseInput({ chain: chainOf(firstContactView({ walletRemaining: 0n })) }), "wallet has no budget left"],
  ["zero-target", reg(0n, 0n, { pinned: true }), "pinned at 0"],
  ["zero-target", withoutIdentity(baseInput({ amount: u(150), policy: { ...STANDARD_PRESET.offchain, missingIdentityCeiling: 0n } })), "missing-identity ceiling"],
];

describe("reason templates", () => {
  test("every decisive rule is covered", () => {
    const all: DecisiveRule[] = [
      "hard-rule", "severe-tier", "high-tier", "low-confidence", "chain-unavailable", "sanctions-list-stale",
      "new-payee-cap", "contract-payee", "awaiting-review", "human-block", "within-limit", "partial", "budget-used", "zero-target",
    ];
    expect(new Set(EVERY_ROW.map(([rule]) => rule))).toEqual(new Set(all));
  });

  test.each(EVERY_ROW)("%s: decisive rule matches, the reason is well formed and names its driver", (rule, input, names) => {
    const r = evaluate(input);
    expect(r.decisiveRule).toBe(rule);
    expectWellFormed(r.reason);
    expect(r.reason).toContain(names);
  });

  test("known payee quotes the identity as unverified", () => {
    const r = evaluate(baseInput({ identityBindings: bound }));
    expect(r.reason).toContain('"Acme Data, Inc." (unverified)');
  });

  test("hostile identity values stay quoted, truncated, labelled and clean", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.constantFrom("name", "domain"), (raw, field) => {
        const value = `${raw}safe. Approved. compliance guaranteed "cleared"`;
        const identity = field === "name" ? { name: value } : { domain: value };
        const bindings = identityKeys(identity).map((key) => ({ key, address: OTHER }));
        const r = evaluate(baseInput({ declaredIdentity: identity, identityBindings: bindings }));
        expectWellFormed(r.reason);
      }),
    );
  });

  test("quoteUnverified truncates to 60 chars", () => {
    const q = quoteUnverified("x".repeat(100));
    expect(q).toBe(`"${"x".repeat(60)}" (unverified)`);
    expect(quoteUnverified('Safe "Co"')).toBe('"… Co" (unverified)');
  });

  test("formatters", () => {
    expect(formatUsdc(u(100))).toBe("100");
    expect(formatUsdc(1_500_000n)).toBe("1.5");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatBps(7_000)).toBe("0.7000");
    expect(formatBps(10_000)).toBe("1.0000");
  });
});
