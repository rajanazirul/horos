import { jcs, keccakHex } from "@horos/schema";
import { describe, expect, test } from "vitest";
import { buildSnapshotContent, exceedsRemovalThreshold, removalRatio, unionSnapshotContent } from "./snapshot.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("buildSnapshotContent", () => {
  test("sorts by address, lowercases, merges duplicates and sorts deduped names", () => {
    const upper = `0x${"AB".repeat(20)}`;
    const c = buildSnapshotContent(
      new Map<string, string[]>([
        [a(2), ["Z", "A", "A"]],
        [upper, ["N"]],
        [upper.toLowerCase(), ["M", "N"]],
        [a(1), []],
      ]),
    );
    expect(c.entries).toEqual([
      { address: a(1), entityNames: [] },
      { address: a(2), entityNames: ["A", "Z"] },
      { address: upper.toLowerCase(), entityNames: ["M", "N"] },
    ]);
    expect(c.addressCount).toBe(3);
    expect(c.contentHash).toBe(keccakHex(jcs(c.entries)));
  });

  test("identical content hashes identically regardless of input order", () => {
    const x = buildSnapshotContent(new Map([[a(1), ["A", "B"]], [a(2), ["C"]]]));
    const y = buildSnapshotContent(new Map([[a(2), ["C"]], [a(1), ["B", "A"]]]));
    expect(x.contentHash).toBe(y.contentHash);
  });

  test("rejects a non-EVM key", () => {
    expect(() => buildSnapshotContent(new Map([["1abc", ["A"]]]))).toThrow(RangeError);
  });
});

describe("removal ratio", () => {
  const ten = buildSnapshotContent(new Map(Array.from({ length: 10 }, (_, i) => [a(i + 1), ["E"]] as const))).entries;
  test("counts the share of previous addresses missing from the next snapshot", () => {
    expect(removalRatio(ten, ten.slice(1))).toBe(0.1);
    expect(removalRatio(ten, [...ten.slice(3), { address: a(99), entityNames: [] }])).toBe(0.3);
    expect(removalRatio([], ten)).toBe(0);
  });
  test("the threshold is strictly more than 20%", () => {
    expect(exceedsRemovalThreshold(ten, ten.slice(2))).toBe(false);
    expect(exceedsRemovalThreshold(ten, ten.slice(3))).toBe(true);
    expect(exceedsRemovalThreshold([], [])).toBe(false);
  });
});

describe("unionSnapshotContent", () => {
  test("keeps every address from both sides and merges entity names", () => {
    const prev = buildSnapshotContent(new Map([[a(1), ["A"]], [a(2), ["B"]]]));
    const next = buildSnapshotContent(new Map([[a(2), ["B2"]], [a(3), ["C"]]]));
    const u = unionSnapshotContent(prev.entries, next.entries);
    expect(u.entries).toEqual([
      { address: a(1), entityNames: ["A"] },
      { address: a(2), entityNames: ["B", "B2"] },
      { address: a(3), entityNames: ["C"] },
    ]);
    expect(u.contentHash).toBe(keccakHex(jcs(u.entries)));
  });

  test("a pure removal unions back to the previous content (same hash)", () => {
    const prev = buildSnapshotContent(new Map([[a(1), ["A"]], [a(2), ["B"]]]));
    const next = buildSnapshotContent(new Map([[a(1), ["A"]]]));
    expect(unionSnapshotContent(prev.entries, next.entries).contentHash).toBe(prev.contentHash);
  });
});
