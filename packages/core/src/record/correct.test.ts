import { DecisionRecord, recordHash, ZERO_BYTES32, type HardRuleResult, type Hex } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { evaluate } from "../evaluate/evaluate.js";
import { baseInput, DEMO_ADDR, firstContactView, IDENTITY, PAYEE, u } from "../evaluate/fixtures.test-helpers.js";
import { REASON_MAX_CHARS } from "../evaluate/reasons.js";
import { intentStateOf, outboxBackoffMs } from "../ports/outbox.js";
import { buildDecisionRecord } from "./build.js";
import { buildCorrectingRecord } from "./correct.js";

const ENFORCED = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const PREV = `0x${"1".repeat(64)}` as Hex;
const ID = "01926f3a-8000-7000-8000-0000000000ff";
const AT = "2026-09-28T12:10:00.000Z";

function prior(): DecisionRecord {
  const e = evaluate(baseInput());
  return buildDecisionRecord(
    {
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
      evaluation: e,
    },
    0,
    ZERO_BYTES32,
  );
}

describe("buildCorrectingRecord", () => {
  test("write-failed: hold, no targetLimit, same context and trigger, templated reason", () => {
    const p = prior();
    expect(p.decision).toBe("allow");
    const r = buildCorrectingRecord(p, { kind: "write-failed", error: "NewPayeeCapReached" }, ID, AT, 7, PREV);
    expect(DecisionRecord.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      id: ID,
      seq: 7,
      prevHash: PREV,
      createdAt: AT,
      decision: "hold",
      trigger: p.trigger,
      scope: p.scope,
      counterparty: p.counterparty,
      customerId: p.customerId,
      policyWallet: p.policyWallet,
      amount: p.amount,
      declaredIdentity: p.declaredIdentity,
      advisory: false,
      simulated: false,
    });
    expect(r).not.toHaveProperty("targetLimit");
    expect(r.reason).toBe(
      "Horos could not write the Limit on-chain (NewPayeeCapReached); payments to this counterparty are held until a new Check succeeds.",
    );
    expect(recordHash(r)).not.toBe(recordHash(p));
  });

  test("write-failed after a prior block stays a block (a matched Hard Rule would otherwise fail to parse)", () => {
    const e = evaluate(baseInput({ counterparty: DEMO_ADDR }));
    expect(e.decision).toBe("block");
    const p = buildDecisionRecord(
      {
        id: "01926f3a-8000-7000-8000-000000000002",
        scope: ENFORCED,
        createdAt: "2026-09-28T12:00:00.000Z",
        trigger: "check",
        channel: "api",
        customerId: "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f",
        policyWallet: WALLET,
        counterparty: DEMO_ADDR,
        skippedQuestions: [],
        questionSetVersion: "v1",
        policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
        presetVersion: "standard@1",
        chainView: firstContactView(),
        chainState: "live",
        evaluation: e,
      },
      0,
      ZERO_BYTES32,
    );
    const r = buildCorrectingRecord(p, { kind: "write-failed", error: "CircleDenied" }, ID, AT, 1, PREV);
    expect(r).toMatchObject({ decision: "block", hardRules: p.hardRules, simulated: true });
    expect(r).not.toHaveProperty("targetLimit");
  });

  test("an odd error name is sanitised and the reason stays within bounds", () => {
    const r = buildCorrectingRecord(prior(), { kind: "write-failed", error: `bad "name" ${"x".repeat(900)}` }, ID, AT, 1, PREV);
    expect(r.reason.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
    expect(r.reason).not.toContain('"');
    expect(buildCorrectingRecord(prior(), { kind: "write-failed", error: "" }, ID, AT, 1, PREV).reason).toContain("(unknown)");
  });

  test("hard-rule: block with the new evidence, severe, confidence 1, simulated from the Demo List", () => {
    const hit: HardRuleResult = { rule: "exact-address-match", source: "horos-demo-list", snapshotId: "demo-2", snapshotHash: `0x${"d".repeat(64)}`, matched: true, entityNames: ["HOROS DEMO ENTITY (TEST)"] };
    const hardRules: HardRuleResult[] = [hit];
    const r = buildCorrectingRecord(prior(), { kind: "hard-rule", hardRules }, ID, AT, 2, PREV);
    expect(r).toMatchObject({ decision: "block", riskTier: "severe", confidence: "1.0000", simulated: true, hardRules });
    expect(r).not.toHaveProperty("targetLimit");
    expect(r.reason).toContain("Horos Demo List");
    expect(() => buildCorrectingRecord(prior(), { kind: "hard-rule", hardRules: [{ ...hit, matched: false }] }, ID, AT, 2, PREV)).toThrow(
      RangeError,
    );
  });

  test("invalid seq/prevHash pairing throws ZodError", () => {
    expect(() => buildCorrectingRecord(prior(), { kind: "write-failed", error: "StaleEpoch" }, ID, AT, 0, PREV)).toThrow(
      expect.objectContaining({ name: "ZodError" }),
    );
  });
});

describe("intentStateOf", () => {
  const row = { status: "pending" as const, recordIds: ["a", "b"], createdByRecord: "a" };
  test("maps the matrix", () => {
    expect(intentStateOf(undefined, "a")).toBe("none");
    expect(intentStateOf(row, "z")).toBe("none");
    expect(intentStateOf(row, "a")).toBe("pending");
    expect(intentStateOf(row, "b")).toBe("coalesced");
    expect(intentStateOf({ ...row, status: "sending" }, "b")).toBe("coalesced");
    expect(intentStateOf({ ...row, status: "submitted" }, "a")).toBe("pending");
    expect(intentStateOf({ ...row, status: "noop" }, "a")).toBe("none");
    expect(intentStateOf({ ...row, status: "confirmed" }, "b")).toBe("confirmed");
    expect(intentStateOf({ ...row, status: "failed" }, "a")).toBe("failed");
  });

  test("backoff is 30s doubling, capped at 10 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(outboxBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });
});
