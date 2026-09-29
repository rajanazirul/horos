import { recordHash } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { chainLines, mixedChainLines, template } from "./chain.test-helpers.js";
import { PACKAGE_NAME, verifyChain } from "./index.js";

describe("verifyChain", () => {
  test("exports its name", () => expect(PACKAGE_NAME).toBe("@horos/verify"));

  test("a valid chain verifies, from text or lines", () => {
    const lines = chainLines(4);
    expect(verifyChain(lines)).toEqual({ ok: true, count: 4 });
    expect(verifyChain(`${lines.join("\n")}\n`)).toEqual({ ok: true, count: 4 });
  });

  test("a chain mixing DecisionRecords and ExternalRecords verifies; editing an external record breaks at that line", () => {
    const lines = mixedChainLines(5);
    expect(verifyChain(lines)).toEqual({ ok: true, count: 5 });
    const obj = JSON.parse(lines[3] ?? "") as { record: { actor: string; blockNumber: number } };
    obj.record.blockNumber += 1;
    lines[3] = JSON.stringify(obj);
    expect(verifyChain(lines)).toEqual({ ok: false, firstBreak: { line: 4, seq: 3, reason: "hash mismatch" } });
  });

  test("an invalid external record reports the external member's issue", () => {
    const lines = mixedChainLines(2);
    const obj = JSON.parse(lines[1] ?? "") as { record: { actor: string } };
    obj.record.actor = "rules"; // a Human-only LimitSet from Rules
    lines[1] = JSON.stringify(obj);
    const r = verifyChain(lines);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.firstBreak).toMatchObject({ line: 2, seq: 1, reason: expect.stringMatching(/record does not parse at actor/) });
  });

  test("an empty export verifies with count 0", () => {
    expect(verifyChain("")).toEqual({ ok: true, count: 0 });
  });

  test("a tampered reason breaks at that line with hash mismatch", () => {
    const lines = chainLines(4);
    const obj = JSON.parse(lines[2] ?? "") as { record: { reason: string } };
    obj.record.reason = "Allowed: nothing to see here.";
    lines[2] = JSON.stringify(obj);
    expect(verifyChain(lines)).toEqual({ ok: false, firstBreak: { line: 3, seq: 2, reason: "hash mismatch" } });
  });

  test("a deleted line reports the seq gap", () => {
    const lines = chainLines(4);
    lines.splice(1, 1);
    const r = verifyChain(lines);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.firstBreak).toMatchObject({ line: 2, seq: 2 });
      expect(r.firstBreak.reason).toMatch(/seq gap: expected 1, found 2/);
    }
  });

  test("two swapped lines report the break at the first swapped one", () => {
    const lines = chainLines(4);
    [lines[1], lines[2]] = [lines[2] ?? "", lines[1] ?? ""];
    const r = verifyChain(lines);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.firstBreak).toMatchObject({ line: 2, seq: 2, reason: "seq gap: expected 1, found 2" });
  });

  test("a relinked record (seq rewritten, hash recomputed) fails the prevHash link", () => {
    const lines = chainLines(3);
    const obj = JSON.parse(lines[1] ?? "") as { record: Record<string, unknown> };
    obj.record["prevHash"] = `0x${"9".repeat(64)}`;
    lines[1] = JSON.stringify({ recordHash: recordHash(obj.record), record: obj.record });
    const r = verifyChain(lines);
    expect(r).toMatchObject({ ok: false, firstBreak: { line: 2, seq: 1 } });
    if (!r.ok) expect(r.firstBreak.reason).toMatch(/prevHash mismatch/);
  });

  test("a scope change is a break", () => {
    const lines = chainLines(2);
    const obj = JSON.parse(lines[1] ?? "") as { record: Record<string, unknown> };
    obj.record["scope"] = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f81";
    lines[1] = JSON.stringify({ recordHash: recordHash(obj.record), record: obj.record });
    const r = verifyChain(lines);
    expect(r).toMatchObject({ ok: false, firstBreak: { line: 2, seq: 1 } });
    if (!r.ok) expect(r.firstBreak.reason).toMatch(/scope changed/);
  });

  test("malformed lines and invalid records are breaks, not exceptions", () => {
    expect(verifyChain(["{nope"])).toEqual({ ok: false, firstBreak: { line: 1, reason: "line is not valid JSON" } });
    expect(verifyChain(["[1]"])).toMatchObject({ ok: false, firstBreak: { line: 1 } });
    const bad = JSON.stringify({ recordHash: `0x${"0".repeat(64)}`, record: { ...template, seq: 0, reason: "" } });
    const r = verifyChain([bad]);
    expect(r).toMatchObject({ ok: false, firstBreak: { line: 1, seq: 0 } });
    if (!r.ok) expect(r.firstBreak.reason).toMatch(/record does not parse at reason/);
  });

  test("an edit only in address or hex case is a break (record not in canonical form)", () => {
    const lines = chainLines(3);
    const obj = JSON.parse(lines[1] ?? "") as { record: Record<string, unknown> };
    obj.record["counterparty"] = String(obj.record["counterparty"]).toUpperCase().replace("0X", "0x");
    lines[1] = JSON.stringify(obj);
    expect(verifyChain(lines)).toEqual({ ok: false, firstBreak: { line: 2, seq: 1, reason: "record not in canonical form" } });
    const lines2 = chainLines(3);
    const obj2 = JSON.parse(lines2[2] ?? "") as { record: Record<string, unknown> };
    obj2.record["prevHash"] = String(obj2.record["prevHash"]).toUpperCase().replace("0X", "0x");
    lines2[2] = JSON.stringify(obj2);
    expect(verifyChain(lines2)).toEqual({ ok: false, firstBreak: { line: 3, seq: 2, reason: "record not in canonical form" } });
  });

  test("an upper-case stored recordHash is rejected", () => {
    const lines = chainLines(2);
    const obj = JSON.parse(lines[0] ?? "") as { recordHash: string; record: unknown };
    obj.recordHash = `0x${obj.recordHash.slice(2).toUpperCase()}`;
    lines[0] = JSON.stringify(obj);
    expect(verifyChain(lines)).toEqual({ ok: false, firstBreak: { line: 1, seq: 0, reason: "recordHash is not lowercase 0x + 64 hex" } });
  });

  test("line numbers count blank lines in raw text", () => {
    const lines = chainLines(2);
    const text = `${lines[0] ?? ""}\n\n{broken\n`;
    expect(verifyChain(text)).toEqual({ ok: false, firstBreak: { line: 3, reason: "line is not valid JSON" } });
  });
});
