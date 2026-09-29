// UUIDv7 (RFC 9562) from the system clock and CSPRNG. Lives in adapters (I/O allowed) so the api and worker share it.
import { randomBytes } from "node:crypto";

/** A lowercase UUIDv7: 48-bit unix-ms timestamp, version 7, variant 10, 74 random bits. */
export function uuidv7(nowMs: number = Date.now()): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) throw new RangeError("timestamp out of range");
  const b = randomBytes(16);
  b.writeUIntBE(nowMs, 0, 6);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
