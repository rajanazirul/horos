// RFC 8785 JSON Canonicalization Scheme (AD-9) and keccak helpers.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "./primitives.js";

/** Thrown when a value cannot be canonicalised under RFC 8785. */
export class JcsError extends TypeError {
  override name = "JcsError";
}

function serializeString(s: string): string {
  if (!s.isWellFormed()) throw new JcsError("string contains a lone surrogate");
  // JSON.stringify escapes exactly the RFC 8785 set: \b \t \n \f \r \" \\ and other
  // C0 controls as lowercase \u00xx; everything else is emitted verbatim.
  return JSON.stringify(s);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new JcsError("non-finite number");
  // ECMAScript Number::toString is the RFC 8785 number serialisation; -0 becomes "0".
  return Object.is(n, -0) ? "0" : String(n);
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (value === null) return "null";
      if (seen.has(value)) throw new JcsError("cyclic structure");
      seen.add(value);
      let out: string;
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          if (item === undefined) throw new JcsError(`undefined at array index ${i}`);
          parts.push(serialize(item, seen));
        }
        out = `[${parts.join(",")}]`;
      } else if (isPlainObject(value)) {
        // Default string sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
        const keys = Object.keys(value).sort();
        const parts: string[] = [];
        for (const key of keys) {
          const member = value[key];
          if (member === undefined) continue;
          parts.push(`${serializeString(key)}:${serialize(member, seen)}`);
        }
        out = `{${parts.join(",")}}`;
      } else {
        throw new JcsError("only plain objects and arrays can be canonicalised");
      }
      seen.delete(value);
      return out;
    }
    default:
      throw new JcsError(`cannot canonicalise a value of type ${typeof value}`);
  }
}

/**
 * Canonical JSON (RFC 8785). Object members with value `undefined` are dropped; `undefined`
 * inside arrays, non-finite numbers, bigints, functions, symbols, non-plain objects, cycles and
 * lone surrogates throw a {@link JcsError}.
 */
export function jcs(value: unknown): string {
  return serialize(value, new Set());
}

/** `0x` + lowercase hex of keccak256 over bytes, or over the UTF-8 encoding of a string. */
export function keccakHex(input: Uint8Array | string): Hex {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/** Byte length of a string's UTF-8 encoding. */
export function utf8ByteLength(s: string): number {
  return utf8ToBytes(s).length;
}
