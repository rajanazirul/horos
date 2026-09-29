import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CsvError, parseCsv, parseSdnCsv } from "./sdn-csv.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/ofac/${name}`, import.meta.url), "utf8");

const hex = (suffix: string) => `0x${suffix.padStart(40, "0")}`;
const SHARED = "0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345601";

describe("parseCsv", () => {
  test("handles quotes, escaped quotes, commas and newlines inside quotes, CRLF and LF", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n"multi\nline",x,\n\n')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["multi\nline", "x", ""],
    ]);
  });

  test("keeps a stray quote in an unquoted field and tolerates a missing final newline", () => {
    expect(parseCsv('ab"c,d')).toEqual([['ab"c', "d"]]);
  });

  test("an unterminated quoted field is an error", () => {
    expect(() => parseCsv('a,"open')).toThrow(CsvError);
  });
});

describe("parseSdnCsv", () => {
  const map = parseSdnCsv(fixture("sdn-sample.csv"));

  test("reads every EVM address in Digital Currency Address features, whatever the ticker", () => {
    expect([...map.keys()].sort()).toEqual(
      [SHARED, hex("a2"), hex("a3"), hex("a4"), hex("a5"), hex("a6"), hex("a7"), hex("a8"), hex("a9"), hex("a10")].sort(),
    );
  });

  test("lowercases mixed-case addresses and merges an address listed under two entities", () => {
    expect(map.get(SHARED)).toEqual(["EXAMPLE CYBER GROUP, LTD.", "SYNTHETIC MIXER SERVICE"]);
    expect(map.get(hex("a7"))).toEqual(['EXAMPLE "QUOTED" TRADING CO.']);
  });

  test("empty ticker and non-ETH tickers count; XBT, TRX and non-feature 0x tokens do not", () => {
    expect(map.get(hex("a4"))).toEqual(["DOE, Jonathan Example"]);
    expect(map.get(hex("a3"))).toEqual(["DOE, Jonathan Example"]);
    expect(map.has(hex("ff"))).toBe(false);
    for (const k of map.keys()) expect(k).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test("the 30% variant removes exactly three addresses", () => {
    const v = parseSdnCsv(fixture("sdn-sample-30pct-removed.csv"));
    expect(v.size).toBe(7);
    expect([hex("a8"), hex("a9"), hex("a10")].some((a) => v.has(a))).toBe(false);
  });

  test("a longer hex run is not truncated into an address", () => {
    const row = `1,"X","-0- ","P","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","Digital Currency Address - ETH 0x${"ab".repeat(32)}."`;
    expect(parseSdnCsv(row).size).toBe(0);
  });

  test("a trailing 0x1A end-of-file byte is stripped, including right after a quoted field", () => {
    const row = `1,"X","-0- ","P","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","Digital Currency Address - ETH 0x${"12".repeat(20)}."`;
    const expected = new Map([[`0x${"12".repeat(20)}`, ["X"]]]);
    expect(parseSdnCsv(`${row}\u001a`)).toEqual(expected);
    expect(parseSdnCsv(`${row}\r\n\u001a`)).toEqual(expected);
    expect(parseCsv(`a,"b"\u001a`)).toEqual([["a", "b\u001a"]]);
  });

  test("rows without Remarks or with placeholders yield nothing", () => {
    expect(parseSdnCsv('1,"A","-0- "\n2,"B","-0- ","P","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- "').size).toBe(0);
  });
});
