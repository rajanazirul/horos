// Immutable list snapshot content (AD-10, AD-21): sorted, lowercased, deduplicated entries whose
// `contentHash = keccakHex(jcs(entries))`. Identical content always hashes identically.
import { jcs, keccakHex, type Hex } from "@horos/schema";
import { compareCodeUnits } from "../ofac/sdn-csv.js";

export interface SnapshotEntry {
  readonly address: string;
  readonly entityNames: readonly string[];
}

export interface SnapshotContent {
  readonly entries: readonly SnapshotEntry[];
  readonly contentHash: Hex;
  readonly addressCount: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

/** Canonical snapshot content from `address → entity names`. Addresses are lowercased and merged. */
export function buildSnapshotContent(map: ReadonlyMap<string, readonly string[]>): SnapshotContent {
  const merged = new Map<string, Set<string>>();
  for (const [raw, names] of map) {
    if (!ADDRESS_RE.test(raw)) throw new RangeError(`not an EVM address: ${raw}`);
    const address = raw.toLowerCase();
    let set = merged.get(address);
    if (set === undefined) {
      set = new Set();
      merged.set(address, set);
    }
    for (const n of names) if (n !== "") set.add(n);
  }
  const entries: SnapshotEntry[] = [...merged.keys()]
    .sort(compareCodeUnits)
    .map((address) => ({ address, entityNames: [...(merged.get(address) ?? [])].sort(compareCodeUnits) }));
  return { entries, contentHash: keccakHex(jcs(entries)), addressCount: entries.length };
}

/** Union of two snapshots' entries (entity names merged), as canonical content. Never drops an address. */
export function unionSnapshotContent(a: readonly SnapshotEntry[], b: readonly SnapshotEntry[]): SnapshotContent {
  const map = new Map<string, string[]>();
  for (const e of [...a, ...b]) map.set(e.address, [...(map.get(e.address) ?? []), ...e.entityNames]);
  return buildSnapshotContent(map);
}

/** Removed and total counts of `prev` addresses missing from `next`. */
export function removalCounts(
  prev: readonly SnapshotEntry[],
  next: readonly SnapshotEntry[],
): { readonly removed: number; readonly total: number } {
  const kept = new Set(next.map((e) => e.address));
  const removed = prev.filter((e) => !kept.has(e.address)).length;
  return { removed, total: prev.length };
}

/** Share of `prev` addresses missing from `next`, in [0, 1]; 0 when `prev` is empty. */
export function removalRatio(prev: readonly SnapshotEntry[], next: readonly SnapshotEntry[]): number {
  const { removed, total } = removalCounts(prev, next);
  return total === 0 ? 0 : removed / total;
}

/** More than 20% of `prev` addresses removed (AD-21 quarantine threshold), in integer arithmetic. */
export function exceedsRemovalThreshold(prev: readonly SnapshotEntry[], next: readonly SnapshotEntry[]): boolean {
  const { removed, total } = removalCounts(prev, next);
  return removed * 5 > total;
}
