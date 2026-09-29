import { DecisionRecord, recordHash, ZERO_BYTES32, type Hex } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { evaluate } from "../evaluate/evaluate.js";
import { baseInput, DEMO_ADDR, firstContactView, registeredView, chainOf, SDN_ADDR, u, PAYEE, IDENTITY, omitKey } from "../evaluate/fixtures.test-helpers.js";
import type { Evaluation } from "../evaluate/types.js";
import { buildDecisionRecord, confidenceFromBps, scopeKind, type RecordContext } from "./build.js";

// zod is not a direct dependency of core; match the error by name.
const ZOD_ERROR = expect.objectContaining({ name: "ZodError" });
const ENFORCED = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
const SHADOW = "shadow:01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

function ctx(evaluation: Evaluation, patch: Partial<RecordContext> = {}): RecordContext {
  return {
    id: "01926f3a-8000-7000-8000-000000000001",
    scope: ENFORCED,
    createdAt: "2026-09-28T12:00:00.000Z",
    trigger: "check",
    channel: "api",
    customerId: "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f",
    policyWallet: WALLET,
    counterparty: PAYEE,
    amount: u(50),
    declaredIdentity: IDENTITY,
    skippedQuestions: [],
    questionSetVersion: "v1",
    policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
    presetVersion: "standard@1",
    chainView: firstContactView(),
    chainState: "live",
    evaluation,
    ...patch,
  };
}

describe("buildDecisionRecord", () => {
  test("genesis allow in an enforced scope maps every field and parses", () => {
    const e = evaluate(baseInput());
    const r = buildDecisionRecord(ctx(e), 0, ZERO_BYTES32);
    expect(DecisionRecord.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      schemaVersion: 1,
      scope: ENFORCED,
      seq: 0,
      prevHash: ZERO_BYTES32,
      policyWallet: WALLET,
      counterparty: PAYEE,
      amount: "50000000",
      declaredIdentity: { status: "unverified", value: IDENTITY },
      decision: e.decision,
      reason: e.reason,
      riskTier: e.riskTier,
      targetLimit: e.targetLimit.toString(),
      simulated: false,
      advisory: false,
      chainState: "live",
    });
    expect(r.hardRules).toEqual(e.hardRules);
    expect(r.signals).toEqual(e.signals);
    // first contact: no on-chain Limit yet
    expect(r).not.toHaveProperty("limitBefore");
    expect(recordHash(r)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("limitBefore is the on-chain Limit when registered", () => {
    const view = registeredView(u(200), u(150));
    const e = evaluate(baseInput({ chain: chainOf(view) }));
    const r = buildDecisionRecord(ctx(e, { chainView: view }), 3, `0x${"1".repeat(64)}` as Hex);
    expect(r.limitBefore).toBe("200000000");
  });

  test("Demo-List match in a shadow scope is simulated and advisory", () => {
    const e = evaluate(baseInput({ counterparty: DEMO_ADDR }));
    const r = buildDecisionRecord(ctx(e, { scope: SHADOW, counterparty: DEMO_ADDR }), 0, ZERO_BYTES32);
    expect(r).toMatchObject({ simulated: true, advisory: true, decision: "block", targetLimit: "0" });
    expect(r).not.toHaveProperty("policyWallet");
  });

  test("SDN block in an enforced scope is real and enforced", () => {
    const e = evaluate(baseInput({ counterparty: SDN_ADDR }));
    const r = buildDecisionRecord(ctx(e, { counterparty: SDN_ADDR }), 0, ZERO_BYTES32);
    expect(r).toMatchObject({ simulated: false, advisory: false, decision: "block", targetLimit: "0", confidence: "1.0000" });
    expect(r.hardRules.some((h) => h.matched && h.source === "ofac-sdn")).toBe(true);
  });

  test("advisory-public and the x402 channel are always advisory", () => {
    const e = evaluate(baseInput());
    expect(buildDecisionRecord(ctx(e, { scope: "advisory-public" }), 0, ZERO_BYTES32).advisory).toBe(true);
    expect(buildDecisionRecord(ctx(e, { channel: "x402" }), 0, ZERO_BYTES32).advisory).toBe(true);
  });

  test("callers cannot inject simulated or advisory", () => {
    const e = evaluate(baseInput());
    const sneaky = { ...ctx(e), simulated: true, advisory: true } as RecordContext;
    const r = buildDecisionRecord(sneaky, 0, ZERO_BYTES32);
    expect(r.simulated).toBe(false);
    expect(r.advisory).toBe(false);
  });

  test("optional context is omitted, never null", () => {
    const e = evaluate(baseInput());
    const rest = omitKey(omitKey(omitKey(ctx(e), "amount"), "declaredIdentity"), "chainView");
    const r = buildDecisionRecord(rest, 0, ZERO_BYTES32);
    for (const k of ["amount", "declaredIdentity", "limitBefore"]) expect(r).not.toHaveProperty(k);
  });

  test("an enforced scope without a policyWallet fails the schema", () => {
    const e = evaluate(baseInput());
    expect(() => buildDecisionRecord(omitKey(ctx(e), "policyWallet"), 0, ZERO_BYTES32)).toThrow(ZOD_ERROR);
  });

  test("the chain invariant is enforced: seq 0 needs the zero prevHash", () => {
    const e = evaluate(baseInput());
    expect(() => buildDecisionRecord(ctx(e), 0, `0x${"1".repeat(64)}` as Hex)).toThrow(ZOD_ERROR);
    expect(() => buildDecisionRecord(ctx(e), 1, ZERO_BYTES32)).toThrow(ZOD_ERROR);
  });
});

describe("confidenceFromBps", () => {
  test.each([
    [10_000, "1.0000"],
    [0, "0.0000"],
    [7_000, "0.7000"],
    [65, "0.0065"],
    [9_999, "0.9999"],
  ])("%i → %s", (bps, s) => expect(confidenceFromBps(bps)).toBe(s));

  test.each([-1, 10_001, 0.5, Number.NaN])("rejects %s", (bps) => expect(() => confidenceFromBps(bps)).toThrow(RangeError));
});

describe("scopeKind", () => {
  test("classifies every AD-25 scope", () => {
    expect(scopeKind(ENFORCED)).toBe("enforced");
    expect(scopeKind(SHADOW)).toBe("shadow");
    expect(scopeKind("advisory-public")).toBe("advisory-public");
    expect(() => scopeKind("other")).toThrow(RangeError);
  });
});
