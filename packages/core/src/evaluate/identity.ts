// Declared Identity normalisation for the known-payee-new-address signal. Declared Identity is
// always unverified; normalisation only makes the binding lookup robust to cosmetic differences.
import type { DeclaredIdentity } from "@horos/schema";

const LEGAL_SUFFIXES = new Set(["inc", "llc", "ltd", "gmbh", "corp", "co", "company", "corporation", "incorporated", "limited", "plc"]);

/** NFKC, lowercase, drop dots ("L.L.C." → "llc"), other punctuation → space, collapse whitespace, strip trailing legal suffixes. */
export function normaliseName(name: string): string {
  const tokens = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\./gu, "")
    .replace(/\p{P}/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 0);
  while (tokens.length > 0 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join(" ");
}

/** NFKC, lowercase, trimmed host: no scheme, `www.`, port, path/query/fragment or trailing dot/slash. */
export function normaliseDomain(domain: string): string {
  let d = domain.normalize("NFKC").toLowerCase().trim();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//u, "");
  d = d.replace(/[/?#].*$/su, "");
  d = d.replace(/:\d*$/u, "");
  while (d.endsWith(".")) d = d.slice(0, -1);
  if (d.startsWith("www.")) d = d.slice(4);
  return d;
}

/**
 * The binding keys of a Declared Identity: `name:<normalised>` and/or `domain:<normalised>`.
 * Empty normalised values produce no key. Callers building `identityBindings` must use this.
 */
export function identityKeys(identity: DeclaredIdentity | undefined): string[] {
  if (identity === undefined) return [];
  const keys: string[] = [];
  if (identity.name !== undefined) {
    const n = normaliseName(identity.name);
    if (n.length > 0) keys.push(`name:${n}`);
  }
  if (identity.domain !== undefined) {
    const d = normaliseDomain(identity.domain);
    if (d.length > 0) keys.push(`domain:${d}`);
  }
  return keys;
}
