import { getAddress } from "viem";
import { describe, expect, test } from "vitest";
import {
  Address,
  Bytes32,
  fromBaseUnits,
  HexSignature,
  PositiveUsdcAmount,
  toBaseUnits,
  toChecksumAddress,
  toWireTime,
  UsdcAmount,
  UuidV7,
  WireTime,
  ZERO_BYTES32,
} from "./index.js";

const LOWER = [
  "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
  "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359",
  "0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb",
  "0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb",
];

describe("Address", () => {
  test.each(LOWER)("EIP-55 checksum matches viem for %s", (a) => {
    expect(toChecksumAddress(a)).toBe(getAddress(a));
  });

  test("toChecksumAddress rejects malformed input", () => {
    for (const a of ["", "0x1234", "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "0xZaaeb6053f3e94c9b9a09f33669435e7ef1beaed"]) {
      expect(() => toChecksumAddress(a)).toThrow(TypeError);
    }
  });

  test("accepts a valid EIP-55 address and lowercases it", () => {
    for (const a of LOWER) expect(Address.parse(getAddress(a))).toBe(a);
  });

  test("accepts all-lower and all-upper hex", () => {
    const a = LOWER[0] ?? "";
    expect(Address.parse(a)).toBe(a);
    expect(Address.parse(`0x${a.slice(2).toUpperCase()}`)).toBe(a);
  });

  test("rejects a mixed-case address that fails EIP-55", () => {
    for (const a of LOWER) {
      const good = getAddress(a);
      // Flip the case of the first hex letter: still mixed case, checksum now wrong.
      const i = good.slice(2).search(/[a-fA-F]/) + 2;
      const ch = good.charAt(i);
      const bad = good.slice(0, i) + (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) + good.slice(i + 1);
      expect(Address.safeParse(bad).success).toBe(false);
    }
  });

  test.each(["", "0x", "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beae", "0xZaaeb6053f3e94c9b9a09f33669435e7ef1beaed"])(
    "rejects malformed %j",
    (a) => {
      expect(Address.safeParse(a).success).toBe(false);
    },
  );
});

describe("USDC amounts", () => {
  test.each(["0", "1", "2500000", "9".repeat(38)])("UsdcAmount accepts %s", (s) => {
    expect(UsdcAmount.parse(s)).toBe(s);
  });

  test.each(["", "-1", "01", "2.5", "1e6", " 1", "9".repeat(39), "0x10"])("UsdcAmount rejects %j", (s) => {
    expect(UsdcAmount.safeParse(s).success).toBe(false);
  });

  test("rejects numbers", () => {
    expect(UsdcAmount.safeParse(2.5).success).toBe(false);
    expect(UsdcAmount.safeParse(2500000).success).toBe(false);
  });

  test("PositiveUsdcAmount rejects 0", () => {
    expect(PositiveUsdcAmount.safeParse("0").success).toBe(false);
    expect(PositiveUsdcAmount.parse("1")).toBe("1");
  });

  test("bigint round-trip", () => {
    for (const v of [0n, 1n, 2_500_000n, 10n ** 38n - 1n]) {
      expect(fromBaseUnits(toBaseUnits(v))).toBe(v);
    }
    expect(() => toBaseUnits(-1n)).toThrow(RangeError);
    expect(() => toBaseUnits(10n ** 38n)).toThrow(RangeError);
    expect(() => fromBaseUnits("1.5")).toThrow();
  });
});

describe("WireTime", () => {
  test("accepts exact ms-precision UTC", () => {
    expect(WireTime.parse("2026-09-28T12:00:00.000Z")).toBe("2026-09-28T12:00:00.000Z");
    expect(WireTime.parse("2028-02-29T23:59:59.999Z")).toBe("2028-02-29T23:59:59.999Z");
  });

  test.each([
    "2026-09-28T12:00:00Z",
    "2026-09-28T12:00:00.00Z",
    "2026-09-28T12:00:00.0000Z",
    "2026-09-28T12:00:00.000+00:00",
    "2026-09-28 12:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2027-02-29T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-09-28T24:00:00.000Z",
  ])("rejects %s", (s) => {
    expect(WireTime.safeParse(s).success).toBe(false);
  });

  test("toWireTime formats and rejects invalid dates", () => {
    expect(toWireTime(new Date(Date.UTC(2026, 8, 28, 12, 0, 0, 5)))).toBe("2026-09-28T12:00:00.005Z");
    expect(() => toWireTime(new Date(Number.NaN))).toThrow();
    expect(() => toWireTime(new Date(Date.UTC(10000, 0, 1)))).toThrow();
  });
});

describe("hex and id primitives", () => {
  test("Bytes32 lowercases and checks length", () => {
    expect(Bytes32.parse(`0x${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
    expect(Bytes32.safeParse(`0x${"ab".repeat(31)}`).success).toBe(false);
    expect(ZERO_BYTES32).toBe(`0x${"0".repeat(64)}`);
  });

  test("HexSignature is 65 bytes", () => {
    expect(HexSignature.safeParse(`0x${"11".repeat(65)}`).success).toBe(true);
    expect(HexSignature.safeParse(`0x${"11".repeat(64)}`).success).toBe(false);
  });

  test("UuidV7", () => {
    expect(UuidV7.safeParse("01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f").success).toBe(true);
    expect(UuidV7.safeParse("01926f3a-7b2c-4d4e-8f10-2a3b4c5d6e7f").success).toBe(false); // v4
    expect(UuidV7.safeParse("01926F3A-7B2C-7D4E-8F10-2A3B4C5D6E7F").success).toBe(false); // uppercase
    expect(UuidV7.safeParse("01926f3a-7b2c-7d4e-cf10-2a3b4c5d6e7f").success).toBe(false); // variant
  });
});
