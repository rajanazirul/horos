// Record-chain verifier (AD-9). Recomputes every hash of an exported Scope chain with `@horos/schema`
// and reports the first break. Since 0.2.0 a chain may mix DecisionRecords and ExternalRecords (the
// `ScopeRecord` union); older verifiers reject chains containing external records. Depends only on @horos/schema so anyone can run it against an export.
import { jcs, recordHash, ScopeRecord, scopeRecordMember, ZERO_BYTES32 } from "@horos/schema";

const HASH_RE = /^0x[0-9a-f]{64}$/u;

export interface ChainBreak {
  /** 1-based line number in the JSON Lines input (blank lines count). */
  readonly line: number;
  /** The seq of the record on that line, when it could be read. */
  readonly seq?: number;
  readonly reason: string;
}

export type VerifyResult = { readonly ok: true; readonly count: number } | { readonly ok: false; readonly firstBreak: ChainBreak };

interface ExportLine {
  readonly recordHash: unknown;
  readonly record: unknown;
}

/** Split JSON Lines text into non-empty lines, keeping their 1-based line numbers. */
export function splitJsonLines(text: string): { readonly line: number; readonly text: string }[] {
  return text
    .split(/\r?\n/u)
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter((l) => l.text.trim() !== "");
}

/**
 * Verify one Scope chain exported as `{recordHash, record}` JSON Lines ordered by seq. Accepts the raw
 * text or pre-split lines. Checks per line: the record parses, `recordHash(record)` equals the stored
 * hash, seq is contiguous from 0, prevHash links to the previous record's hash, and the scope is constant.
 */
export function verifyChain(input: string | readonly string[]): VerifyResult {
  const lines = typeof input === "string" ? splitJsonLines(input) : input.map((t, i) => ({ line: i + 1, text: t }));
  let expectedSeq = 0;
  let prevHash: string = ZERO_BYTES32;
  let scope: string | undefined;
  for (const { line, text } of lines) {
    const fail = (reason: string, seq?: number): VerifyResult => ({
      ok: false,
      firstBreak: seq === undefined ? { line, reason } : { line, seq, reason },
    });
    let parsed: ExportLine;
    try {
      const raw: unknown = JSON.parse(text);
      if (typeof raw !== "object" || raw === null || !("record" in raw) || !("recordHash" in raw)) {
        return fail("line is not a {recordHash, record} object");
      }
      parsed = raw as ExportLine;
    } catch {
      return fail("line is not valid JSON");
    }
    const rawSeq = (parsed.record as { seq?: unknown } | null)?.seq;
    const seqHint = typeof rawSeq === "number" && Number.isInteger(rawSeq) ? rawSeq : undefined;
    const result = ScopeRecord.safeParse(parsed.record);
    if (!result.success) {
      // Report the issue of the member the record claims to be (by recordType), not the bare union failure.
      const member = scopeRecordMember(parsed.record).safeParse(parsed.record);
      const first = (member.success ? result.error : member.error).issues[0];
      const where = first === undefined || first.path.length === 0 ? "" : ` at ${first.path.join(".")}`;
      return fail(`record does not parse${where}: ${first?.message ?? "invalid"}`, seqHint);
    }
    const record = result.data;
    // The export must already be canonical: normalisation (address/hex case) would hide edits.
    let rawCanonical: string;
    try {
      rawCanonical = jcs(parsed.record);
    } catch {
      return fail("record not in canonical form", record.seq);
    }
    if (rawCanonical !== jcs(record)) return fail("record not in canonical form", record.seq);
    if (typeof parsed.recordHash !== "string" || !HASH_RE.test(parsed.recordHash)) {
      return fail("recordHash is not lowercase 0x + 64 hex", record.seq);
    }
    if (recordHash(record) !== parsed.recordHash) return fail("hash mismatch", record.seq);
    if (scope === undefined) scope = record.scope;
    else if (record.scope !== scope) return fail(`scope changed from ${scope} to ${record.scope}`, record.seq);
    if (record.seq !== expectedSeq) return fail(`seq gap: expected ${expectedSeq}, found ${record.seq}`, record.seq);
    if (record.prevHash !== prevHash) return fail("prevHash mismatch: does not link to the previous record", record.seq);
    prevHash = parsed.recordHash;
    expectedSeq++;
  }
  return { ok: true, count: expectedSeq };
}
