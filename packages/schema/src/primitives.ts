// Wire primitives shared by every Horos surface (AD-9, AD-17, Consistency Conventions).
// Pure: no I/O, clock, randomness or env reads.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

/** A `0x`-prefixed hex string (viem-compatible type). */
export type Hex = `0x${string}`;

/** 32 zero bytes: genesis `prevHash`, absent `declaredIdentityHash` / `reasonHash`. */
export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 checksum form of a 40-hex-digit address (input must match `ADDRESS_RE`). */
export function toChecksumAddress(address: string): Hex {
  if (!ADDRESS_RE.test(address)) throw new TypeError("expected 0x followed by 40 hex digits");
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const c = lower.charAt(i);
    out += Number.parseInt(hash.charAt(i), 16) >= 8 ? c.toUpperCase() : c;
  }
  return out as Hex;
}

function isValidAddressCase(address: string): boolean {
  // zod still runs refinements after a failed regex check, so guard here.
  if (!ADDRESS_RE.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/**
 * An EVM address. Accepts all-lower or all-upper hex, or a mixed-case string that passes
 * EIP-55. Output is always lowercase.
 */
export const Address = z
  .string()
  .regex(ADDRESS_RE, "expected 0x followed by 40 hex digits")
  .refine(isValidAddressCase, "mixed-case address fails the EIP-55 checksum")
  .transform((s) => s.toLowerCase() as Hex);
export type Address = z.output<typeof Address>;

/** Maximum digits of a USDC base-unit amount (fits Postgres `numeric(38,0)`). */
export const USDC_MAX_DIGITS = 38;
const USDC_RE = /^(0|[1-9][0-9]*)$/;
const USDC_LIMIT = 10n ** BigInt(USDC_MAX_DIGITS);

/** A USDC amount in 6-dp base units as a canonical decimal string (≥ 0, ≤ 38 digits). */
export const UsdcAmount = z
  .string()
  .max(USDC_MAX_DIGITS, `at most ${USDC_MAX_DIGITS} digits`)
  .regex(USDC_RE, "expected a non-negative integer decimal string of base units");
export type UsdcAmount = z.output<typeof UsdcAmount>;

/** A USDC base-unit amount that is strictly greater than zero. */
export const PositiveUsdcAmount = UsdcAmount.refine((s) => s !== "0", "amount must be greater than 0");
export type PositiveUsdcAmount = z.output<typeof PositiveUsdcAmount>;

/** Serialise a `bigint` of 6-dp USDC base units to its wire string. Throws when out of range. */
export function toBaseUnits(value: bigint): UsdcAmount {
  if (value < 0n || value >= USDC_LIMIT) {
    throw new RangeError("USDC base units must be in [0, 10^38)");
  }
  return value.toString(10);
}

/** Parse a wire string of 6-dp USDC base units into a `bigint`. Throws when malformed. */
export function fromBaseUnits(amount: string): bigint {
  return BigInt(UsdcAmount.parse(amount));
}

const WIRE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRealInstant(s: string): boolean {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s;
}

/** UTC ISO-8601 with exactly 3 fractional digits (`YYYY-MM-DDTHH:mm:ss.SSSZ`), a real calendar instant. */
export const WireTime = z
  .string()
  .regex(WIRE_TIME_RE, "expected YYYY-MM-DDTHH:mm:ss.SSSZ")
  .refine(isRealInstant, "not a real calendar instant");
export type WireTime = z.output<typeof WireTime>;

/** Format a `Date` as a wire time. Throws for invalid dates or years outside 0000–9999. */
export function toWireTime(date: Date): WireTime {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("invalid Date");
  return WireTime.parse(date.toISOString());
}

/** 32 bytes as `0x` + 64 hex digits; output lowercase. */
export const Bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x followed by 64 hex digits")
  .transform((s) => s.toLowerCase() as Hex);
export type Bytes32 = z.output<typeof Bytes32>;

/** A 65-byte ECDSA signature (`r ‖ s ‖ v`) as `0x` + 130 hex digits; output lowercase. */
export const HexSignature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte hex signature")
  .transform((s) => s.toLowerCase() as Hex);
export type HexSignature = z.output<typeof HexSignature>;

/** Regex source for a lowercase UUIDv7 (RFC 9562), reused by composite formats. */
export const UUID_V7_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** A lowercase UUIDv7 (RFC 9562). */
export const UuidV7 = z.string().regex(new RegExp(`^${UUID_V7_PATTERN}$`), "expected a lowercase UUIDv7");
export type UuidV7 = z.output<typeof UuidV7>;
