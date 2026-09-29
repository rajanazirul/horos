import { keccak256, stringToBytes, toHex } from "viem";
import { describe, expect, test } from "vitest";
import { jcs, JcsError, keccakHex } from "./index.js";

describe("jcs (RFC 8785)", () => {
  test("§3.2.2 sample", () => {
    const input = {
      // Verbatim RFC 8785 input; the precision loss is the point of the vector.
      // eslint-disable-next-line no-loss-of-precision
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "€$\x0F\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  test("§3.2.3 key sorting by UTF-16 code units", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    expect(jcs(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  test.each([
    [0, "0"],
    [-0, "0"],
    [5e-324, "5e-324"],
    [-5e-324, "-5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [9007199254740992, "9007199254740992"],
    [-9007199254740992, "-9007199254740992"],
    [295147905179352830000, "295147905179352830000"],
    [9.999999999999997e22, "9.999999999999997e+22"],
    [1e23, "1e+23"],
    [0.000001, "0.000001"],
    [9.999999999999997e-7, "9.999999999999997e-7"],
    [333333333.3333332, "333333333.3333332"],
  ])("Appendix B number %s → %s", (n, s) => {
    expect(jcs(n)).toBe(s);
  });

  test("escapes controls and keeps other characters verbatim", () => {
    expect(jcs("\b\t\n\f\r\u0001\u001f\u007f é")).toBe('"\\b\\t\\n\\f\\r\\u0001\\u001f\u007f é"');
  });

  test("nested structures and empty containers", () => {
    expect(jcs({ b: [], a: {}, c: [{ z: 1, y: "x" }] })).toBe('{"a":{},"b":[],"c":[{"y":"x","z":1}]}');
  });

  test("drops undefined object members, preserves array order", () => {
    expect(jcs({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
  });

  test.each<[string, unknown]>([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["undefined", undefined],
    ["function", () => 1],
    ["symbol", Symbol("x")],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["undefined in array", [1, undefined]],
    ["sparse array", [1, , 2]], // eslint-disable-line no-sparse-arrays
    ["lone high surrogate", "a\ud800"],
    ["lone low surrogate key", { "\udc00": 1 }],
  ])("rejects %s", (_label, value) => {
    expect(() => jcs(value)).toThrow(JcsError);
  });

  test("rejects cycles", () => {
    const o: Record<string, unknown> = {};
    o["self"] = o;
    expect(() => jcs(o)).toThrow(JcsError);
  });

  test("accepts shared (non-cyclic) references and null-prototype objects", () => {
    const shared = { x: 1 };
    const np = Object.assign(Object.create(null) as Record<string, unknown>, { k: "v" });
    expect(jcs({ a: shared, b: shared, c: np })).toBe('{"a":{"x":1},"b":{"x":1},"c":{"k":"v"}}');
  });
});

describe("keccakHex", () => {
  test.each(["", "abc", "Horos ✓ 😀"])("matches viem keccak256 for %j", (s) => {
    expect(keccakHex(s)).toBe(keccak256(toHex(stringToBytes(s))));
    expect(keccakHex(stringToBytes(s))).toBe(keccak256(stringToBytes(s)));
  });
});
