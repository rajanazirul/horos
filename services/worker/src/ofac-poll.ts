// Hourly OFAC SDN.CSV poll (AD-10, AD-21). A conditional GET; 304 and unchanged content only bump
// freshness; new content becomes the active snapshot in one transaction unless it removes more than
// 20% of the active addresses, in which case it is quarantined, the union of the previous and new lists
// becomes active (AD-10 as amended 2026-09-26: additions apply at once, removals wait for review), and
// the founder is alerted. Every
// failure leaves `last_verified_at` alone, so staleness holds first contacts (fail closed).
import {
  buildSnapshotContent,
  exceedsRemovalThreshold,
  parseSdnCsv,
  removalCounts,
  unionSnapshotContent,
  type FetchSdn,
  type PostgresListStore,
} from "@horos/adapters";
import type { Notifier } from "@horos/core";

export const OFAC_SOURCE = "ofac-sdn" as const;

export interface OfacPollDeps {
  readonly store: PostgresListStore;
  readonly fetchSdn: FetchSdn;
  readonly notifier: Notifier;
  readonly now: Date;
  readonly newId: () => string;
}

export type OfacPollOutcome =
  | { readonly kind: "not-modified" }
  | { readonly kind: "unchanged"; readonly snapshotId: string }
  | { readonly kind: "activated"; readonly snapshotId: string; readonly addressCount: number }
  | {
      readonly kind: "quarantined";
      readonly snapshotId: string;
      /** The active snapshot after the merge: previous list ∪ quarantined update. */
      readonly mergedSnapshotId: string;
      /** Addresses in the quarantined update that were not in the previous list (now enforced). */
      readonly added: number;
      readonly removed: number;
      readonly total: number;
      /** True when this poll delivered the founder alert (false if already alerted for this content, or failed). */
      readonly alerted: boolean;
      /** Set when the founder alert could not be delivered (recorded on the job, never thrown). */
      readonly alertError?: string;
    };

/** A poll that must not count as a verification. The message is safe to store on the job row. */
export class OfacPollError extends Error {
  override readonly name = "OfacPollError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export async function runOfacPoll(deps: OfacPollDeps): Promise<OfacPollOutcome> {
  const { store, now } = deps;
  const state = await store.sourceState(OFAC_SOURCE);
  const lastModified = state?.lastModified ?? undefined;

  let res;
  try {
    res = await deps.fetchSdn(lastModified);
  } catch (err) {
    throw new OfacPollError(`SDN fetch failed: ${errorMessage(err)}`);
  }

  if (res.status === 304) {
    await store.markVerified(OFAC_SOURCE, { now });
    return { kind: "not-modified" };
  }
  if (res.status !== 200 || !("body" in res)) throw new OfacPollError(`SDN fetch returned HTTP ${res.status}`);

  let content;
  try {
    content = buildSnapshotContent(parseSdnCsv(res.body));
  } catch (err) {
    throw new OfacPollError(`SDN parse failed: ${errorMessage(err)}`);
  }
  const newLastModified = res.lastModified ?? null;
  const active = await store.activeSnapshot(OFAC_SOURCE);

  // Any empty parse fails: activating an empty list would look fresh yet match nothing (fail open).
  if (content.addressCount === 0) throw new OfacPollError("SDN parse yielded 0 EVM addresses");
  if (active !== undefined && active.contentHash === content.contentHash) {
    await store.markVerified(OFAC_SOURCE, { now, lastModified: newLastModified });
    return { kind: "unchanged", snapshotId: active.id };
  }

  const snap = { id: deps.newId(), source: OFAC_SOURCE, content, fetchedAt: now };

  if (active !== undefined && exceedsRemovalThreshold(active.entries, content.entries)) {
    const { removed, total } = removalCounts(active.entries, content.entries);
    // Additions apply at once through the union; removals wait for review. Keep the previous
    // Last-Modified so the next poll refetches and re-evaluates; freshness still moves.
    const merged = unionSnapshotContent(active.entries, content.entries);
    const added = merged.addressCount - active.addressCount;
    const mergedSnap = { id: deps.newId(), source: OFAC_SOURCE, content: merged, fetchedAt: now };
    const q = await store.quarantineAndMerge(snap, mergedSnap, { now });
    const base = { kind: "quarantined" as const, snapshotId: q.snapshotId, mergedSnapshotId: q.mergedSnapshotId, added, removed, total };
    // Exactly one delivered alert per quarantined content; a failed one is retried on the next poll.
    if (state?.quarantineAlertedHash === content.contentHash) {
      return { ...base, alerted: false };
    }
    try {
      await deps.notifier.notify({
        kind: "list-quarantined",
        source: OFAC_SOURCE,
        message:
          `OFAC SDN update quarantined: it removes ${removed} of ${total} active addresses (more than 20%). ` +
          `Snapshot ${q.snapshotId} (${content.contentHash}) was stored as quarantined. Its ${added} new address(es) are enforced now: ` +
          `the active list is ${q.mergedSnapshotId}, the union of the previous snapshot ${active.id} and this update. The removals wait for your review.`,
      });
    } catch (err) {
      return { ...base, alerted: false, alertError: errorMessage(err) };
    }
    await store.markQuarantineAlerted(OFAC_SOURCE, content.contentHash);
    return { ...base, alerted: true };
  }

  const r = await store.activate(snap, { now, lastModified: newLastModified });
  return { kind: "activated", snapshotId: r.snapshotId, addressCount: content.addressCount };
}
