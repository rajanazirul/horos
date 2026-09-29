// Shared test fixtures (imported by *.test.ts only; excluded from the build).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordHash, ZERO_BYTES32 } from "@horos/schema";

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/golden-record-hashes.json", import.meta.url)), "utf8"),
) as { name: string; record: Record<string, unknown> }[];
export const template = golden[0]?.record ?? missing();
/** A golden ExternalRecord (same Scope as `template`). */
export const externalTemplate = golden.find((g) => g.name === "external-human-limit-set")?.record ?? missing();
function missing(): never {
  throw new Error("no golden vector");
}

/** A valid chain of `n` records as JSON Lines. */
export function chainLines(n: number): string[] {
  const lines: string[] = [];
  let prev: string = ZERO_BYTES32;
  for (let seq = 0; seq < n; seq++) {
    const record = { ...template, id: `01926f3a-8000-7000-8000-${String(seq).padStart(12, "0")}`, seq, prevHash: prev };
    const hash = recordHash(record);
    lines.push(JSON.stringify({ recordHash: hash, record }));
    prev = hash;
  }
  return lines;
}

/** A valid chain of `n` records alternating DecisionRecord (even seq) and ExternalRecord (odd seq). */
export function mixedChainLines(n: number): string[] {
  const lines: string[] = [];
  let prev: string = ZERO_BYTES32;
  for (let seq = 0; seq < n; seq++) {
    const base = seq % 2 === 0 ? template : externalTemplate;
    const record = { ...base, id: `01926f3a-8000-7000-8000-${String(seq).padStart(12, "0")}`, seq, prevHash: prev };
    const hash = recordHash(record);
    lines.push(JSON.stringify({ recordHash: hash, record }));
    prev = hash;
  }
  return lines;
}
