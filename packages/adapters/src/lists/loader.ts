// Store-backed list loader (AD-10): the active snapshot of every source as core `ListSnapshot`s. An SDN
// source without an active snapshot is simply absent, which core treats as stale (fail closed).
import type { ListSnapshot } from "@horos/core";
import type { PostgresListStore } from "../postgres/list-store.js";

export async function loadActiveListSnapshots(store: PostgresListStore): Promise<ListSnapshot[]> {
  const lists = await store.activeLists();
  return lists.map(({ snapshot, lastVerifiedAt }) => ({
    source: snapshot.source,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.contentHash,
    entries: new Map(snapshot.entries.map((e) => [e.address, [...e.entityNames]])),
    // Never verified → NaN, which core counts as stale.
    lastVerifiedAt: lastVerifiedAt === null ? Number.NaN : lastVerifiedAt.getTime(),
  }));
}
