import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, stringToBytes } from "viem";
import { describe, expect, test } from "vitest";
import { ZodError } from "zod";
import {
  canonicalRecord,
  DecisionRecord,
  EXTERNAL_RECORD_REASON,
  ExternalRecord,
  isExternalRecord,
  jcs,
  JcsError,
  recordHash,
  ScopeRecord,
  scopeRecordMember,
} from "./index.js";

interface Golden {
  name: string;
  record: Record<string, unknown>;
  canonical: string;
  hash: string;
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/golden-record-hashes.json", import.meta.url)), "utf8"),
) as Golden[];

function first(): Record<string, unknown> {
  const g = golden[0];
  if (g === undefined) throw new Error("no golden vectors");
  return structuredClone(g.record);
}

describe("golden record hashes", () => {
  test("covers the required scenarios", () => {
    expect(golden.length).toBeGreaterThanOrEqual(4);
    expect(golden.map((g) => g.name)).toEqual([
      "minimal-allow",
      "cap-with-declared-identity",
      "block-demo-list-simulated",
      "advisory-hold-unicode-reason",
      "shadow-allow",
      "external-human-limit-set",
      "external-policy-changed",
      "external-unrecognised-registrar",
    ]);
  });

  test.each(golden.map((g) => [g.name, g] as const))("%s", (_name, g) => {
    expect(jcs(g.record)).toBe(g.canonical);
    expect(canonicalRecord(g.record)).toBe(g.canonical);
    expect(recordHash(g.record)).toBe(g.hash);
    expect(keccak256(stringToBytes(g.canonical))).toBe(g.hash);
  });
});

describe("recordHash", () => {
  test("normalises addresses: EIP-55 input hashes like lowercase", () => {
    const r = first();
    const h = recordHash(r);
    expect(recordHash({ ...r, counterparty: getAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359") })).toBe(h);
  });

  test("key order does not matter; array order does", () => {
    const r = first();
    const reversed = Object.fromEntries(Object.entries(r).reverse());
    expect(recordHash(reversed)).toBe(recordHash(r));
    const g = golden[2]?.record;
    if (g === undefined) throw new Error("missing vector");
    const rules = g["hardRules"] as unknown[];
    expect(recordHash({ ...g, hardRules: [...rules].reverse() })).not.toBe(recordHash(g));
  });

  test("any field change changes the hash", () => {
    const r = first();
    expect(recordHash({ ...r, amount: "2500001" })).not.toBe(recordHash(r));
  });

  test.each<[string, (r: Record<string, unknown>) => unknown]>([
    ["null optional", (r) => ({ ...r, limitBefore: null })],
    ["null required", (r) => ({ ...r, reason: null })],
    ["unknown key", (r) => ({ ...r, extra: "x" })],
    ["non-integer seq", (r) => ({ ...r, seq: 1.5 })],
    ["unsafe seq", (r) => ({ ...r, seq: 2 ** 53 })],
    ["negative seq", (r) => ({ ...r, seq: -1 })],
    ["non-integer signal value", (r) => ({ ...r, signals: [{ id: "s", value: 0.5, tierContribution: "low" }] })],
    ["undefined in array", (r) => ({ ...r, skippedQuestions: ["q", undefined] })],
    ["float confidence", (r) => ({ ...r, confidence: 1 })],
    ["3-dp confidence", (r) => ({ ...r, confidence: "0.650" })],
    ["numeric amount", (r) => ({ ...r, amount: 2500000 })],
    ["bad time", (r) => ({ ...r, createdAt: "2026-09-28T12:00:00Z" })],
    ["bad scope", (r) => ({ ...r, scope: "enforced:abc" })],
    ["schemaVersion 2", (r) => ({ ...r, schemaVersion: 2 })],
    ["empty reason", (r) => ({ ...r, reason: "" })],
    ["reason > 600", (r) => ({ ...r, reason: "x".repeat(601) })],
    ["explicit undefined optional", (r) => ({ ...r, limitBefore: undefined })],
  ])("rejects %s with ZodError", (_label, mutate) => {
    expect(() => recordHash(mutate(first()))).toThrow(ZodError);
  });

  test("rejects lone surrogates", () => {
    expect(() => recordHash({ ...first(), reason: "bad \ud800" })).toThrow(JcsError);
  });

  test("declared identity must be marked unverified", () => {
    const g = golden[1]?.record;
    if (g === undefined) throw new Error("missing vector");
    expect(() => recordHash({ ...g, declaredIdentity: { status: "verified", value: { name: "Acme" } } })).toThrow(ZodError);
  });

  test("absent optionals are omitted from the parsed record and the hash equals the golden one", () => {
    const r = first();
    expect("limitBefore" in r).toBe(false);
    expect(DecisionRecord.parse(r)).not.toHaveProperty("limitBefore");
    expect(recordHash(r)).toBe(golden[0]?.hash);
  });

  test("reason at 600 characters is accepted", () => {
    expect(() => recordHash({ ...first(), reason: "x".repeat(600) })).not.toThrow();
  });
});

describe("DecisionRecord invariants", () => {
  const vector = (i: number): Record<string, unknown> => {
    const g = golden[i];
    if (g === undefined) throw new Error("missing vector");
    return structuredClone(g.record);
  };
  const ZERO = `0x${"0".repeat(64)}`;

  test("every golden DecisionRecord vector satisfies them (hashes unchanged)", () => {
    for (const g of golden.filter((v) => v.record["recordType"] === undefined)) {
      expect(() => DecisionRecord.parse(g.record)).not.toThrow();
      expect(recordHash(g.record)).toBe(g.hash);
    }
  });

  test.each<[string, () => unknown]>([
    ["seq 0 with a non-zero prevHash", () => ({ ...vector(0), prevHash: `0x${"1".repeat(64)}` })],
    ["seq > 0 with the zero prevHash", () => ({ ...vector(1), prevHash: ZERO })],
    ["enforced scope without policyWallet", () => omit(vector(0), "policyWallet")],
    ["shadow scope not advisory", () => ({ ...vector(4), advisory: false })],
    ["advisory-public scope not advisory", () => ({ ...vector(3), advisory: false })],
    ["advisory-public record with a policyWallet", () => ({ ...vector(3), policyWallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" })],
    ["shadow record for a different Customer", () => ({ ...vector(4), customerId: "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e70" })],
    ["matched Hard Rule without block", () => ({ ...vector(2), decision: "hold" })],
    ["block with a positive targetLimit", () => ({ ...vector(2), targetLimit: "1" })],
    ["hold with a positive targetLimit", () => ({ ...vector(3), targetLimit: "5" })],
  ])("rejects %s", (_label, make) => {
    expect(() => DecisionRecord.parse(make())).toThrow(ZodError);
  });

  test("hold or block with targetLimit absent or 0 is accepted", () => {
    expect(() => DecisionRecord.parse({ ...vector(3), targetLimit: "0" })).not.toThrow();
    expect(() => DecisionRecord.parse(omit(vector(2), "targetLimit"))).not.toThrow();
  });

  test("an enforced record may be advisory (x402 channel)", () => {
    expect(() => DecisionRecord.parse({ ...vector(0), advisory: true })).not.toThrow();
  });

  test("a structurally invalid record still fails with ZodError, not a TypeError", () => {
    expect(() => DecisionRecord.parse({ ...vector(0), scope: 42 })).toThrow(ZodError);
    expect(() => DecisionRecord.parse({})).toThrow(ZodError);
  });
});

describe("ExternalRecord", () => {
  const external = golden.filter((g) => g.record["recordType"] === "external");
  const vector = (name: string): Record<string, unknown> => {
    const g = golden.find((v) => v.name === name);
    if (g === undefined) throw new Error(`missing vector ${name}`);
    return structuredClone(g.record);
  };
  const ZERO = `0x${"0".repeat(64)}`;
  const CP = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
  const OTHER = "0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb";

  test("three golden vectors: a Human LimitSet, a counterparty-less PolicyChanged, an unrecognised Registrar registration", () => {
    expect(external.map((g) => g.name)).toEqual(["external-human-limit-set", "external-policy-changed", "external-unrecognised-registrar"]);
    for (const g of external) {
      const parsed = ScopeRecord.parse(g.record);
      expect(isExternalRecord(parsed)).toBe(true);
      expect(parsed.reason).toBe(EXTERNAL_RECORD_REASON);
      expect(scopeRecordMember(g.record)).toBe(ExternalRecord);
    }
    expect(vector("external-policy-changed")).not.toHaveProperty("counterparty");
  });

  test("a DecisionRecord never parses as external and vice versa", () => {
    const d = golden[0]?.record;
    expect(isExternalRecord(ScopeRecord.parse(d))).toBe(false);
    expect(scopeRecordMember(d)).toBe(DecisionRecord);
    expect(() => DecisionRecord.parse(vector("external-policy-changed"))).toThrow(ZodError);
    expect(() => ExternalRecord.parse(d)).toThrow(ZodError);
  });

  test.each<[string, () => unknown]>([
    ["a non-enforced scope", () => ({ ...vector("external-policy-changed"), scope: "shadow:01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f" })],
    ["seq 0 with a non-zero prevHash", () => ({ ...vector("external-policy-changed"), seq: 0 })],
    ["seq > 0 with the zero prevHash", () => ({ ...vector("external-policy-changed"), prevHash: ZERO })],
    ["no events", () => ({ ...vector("external-policy-changed"), events: [] })],
    ["events out of logIndex order", () => {
      const r = vector("external-human-limit-set");
      const [e] = r["events"] as Record<string, unknown>[];
      return { ...r, events: [{ ...e, logIndex: 4 }, { logIndex: 4, name: "PinReleased", args: { counterparty: CP, recordHash: ZERO } }] };
    }],
    ["a counterparty when an event has none", () => ({ ...vector("external-policy-changed"), counterparty: CP })],
    ["a missing counterparty when every event shares one", () => omit(vector("external-unrecognised-registrar"), "counterparty")],
    ["a counterparty that differs from the events'", () => ({ ...vector("external-unrecognised-registrar"), counterparty: OTHER })],
    ["a Human-only event from a non-Human actor", () => ({ ...vector("external-human-limit-set"), actor: "rules" })],
    ["OwnershipTransferred from the registrar", () => ({
      ...omit(vector("external-policy-changed"), "counterparty"),
      actor: "registrar",
      events: [{ logIndex: 0, name: "OwnershipTransferred", args: { from: CP, to: OTHER, recordHash: ZERO } }],
    })],
    ["an unknown event name", () => ({ ...vector("external-policy-changed"), events: [{ logIndex: 0, name: "Pinned", args: {} }] })],
    ["an uppercase hex arg", () => ({ ...vector("external-policy-changed"), events: [{ logIndex: 0, name: "PolicyChanged", args: { recordHash: `0x${"A".repeat(64)}` } }] })],
    ["a snake_case arg key", () => ({ ...vector("external-policy-changed"), events: [{ logIndex: 0, name: "PolicyChanged", args: { old_value: "1" } }] })],
    ["simulated true", () => ({ ...vector("external-policy-changed"), simulated: true })],
    ["advisory true", () => ({ ...vector("external-policy-changed"), advisory: true })],
    ["an evaluation field", () => ({ ...vector("external-policy-changed"), decision: "hold" })],
    ["a non-integer blockNumber", () => ({ ...vector("external-policy-changed"), blockNumber: 1.5 })],
  ])("rejects %s", (_label, make) => {
    expect(() => ExternalRecord.parse(make())).toThrow(ZodError);
    expect(() => recordHash(make())).toThrow(ZodError);
  });

  test("OwnershipTransferred accepts pending-human; events sharing a counterparty keep it", () => {
    const r = {
      ...omit(vector("external-policy-changed"), "counterparty"),
      actor: "pending-human",
      events: [{ logIndex: 0, name: "OwnershipTransferred", args: { from: CP, to: OTHER, recordHash: ZERO } }],
    };
    expect(() => ExternalRecord.parse(r)).not.toThrow();
    const multi = {
      ...vector("external-human-limit-set"),
      events: [
        { logIndex: 0, name: "CounterpartyRegistered", args: { counterparty: CP, limit: "300000000", recordHash: ZERO } },
        { logIndex: 1, name: "LimitSet", args: { counterparty: CP, oldLimit: "0", newLimit: "300000000", humanEpoch: "1", recordHash: ZERO } },
      ],
    };
    expect(ExternalRecord.parse(multi).counterparty).toBe(CP);
  });

  test("any field change changes the hash", () => {
    const r = vector("external-human-limit-set");
    expect(recordHash({ ...r, blockNumber: 1205 })).not.toBe(recordHash(r));
  });
});

function omit(r: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));
}
