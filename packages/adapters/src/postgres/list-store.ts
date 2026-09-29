// Postgres list persistence (AD-10, AD-21). Snapshots are insert-only; `list_source` is a mutable
// pointer row (active snapshot + freshness). No code path updates or deletes a snapshot.
import { ListSource, type Hex } from "@horos/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type { HorosDb } from "./db.js";
import { listSnapshot, listSource } from "./schema.js";
import type { SnapshotContent, SnapshotEntry } from "../lists/snapshot.js";

export type SnapshotStatus = "active" | "quarantined";

export interface StoredSnapshot {
  readonly id: string;
  readonly source: ListSource;
  readonly contentHash: Hex;
  readonly entries: readonly SnapshotEntry[];
  readonly addressCount: number;
  readonly status: SnapshotStatus;
  readonly fetchedAt: Date;
}

export interface ListSourceState {
  readonly source: ListSource;
  readonly lastVerifiedAt: Date | null;
  readonly lastModified: string | null;
  readonly activeSnapshotId: string | null;
  readonly quarantineAlertedHash: string | null;
}

export interface ActiveList {
  readonly snapshot: StoredSnapshot;
  readonly lastVerifiedAt: Date | null;
}

export interface NewSnapshot {
  readonly id: string;
  readonly source: ListSource;
  readonly content: SnapshotContent;
  readonly fetchedAt: Date;
}

/** Poll metadata written together with a snapshot. `lastModified: undefined` keeps the stored value. */
export interface VerifiedAt {
  readonly now: Date;
  readonly lastModified?: string | null;
}

type Tx = Parameters<Parameters<HorosDb["transaction"]>[0]>[0];
type Conn = HorosDb | Tx;

const HEX_RE = /^0x[0-9a-f]{64}$/u;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;

function parseEntries(raw: unknown): SnapshotEntry[] {
  if (!Array.isArray(raw)) throw new TypeError("list_snapshot.entries is not an array");
  return raw.map((e: unknown) => {
    const { address, entityNames } = (e ?? {}) as { address?: unknown; entityNames?: unknown };
    if (typeof address !== "string" || !ADDRESS_RE.test(address)) throw new TypeError("bad snapshot entry address");
    if (!Array.isArray(entityNames) || !entityNames.every((n) => typeof n === "string")) {
      throw new TypeError("bad snapshot entry entityNames");
    }
    return { address, entityNames: entityNames as string[] };
  });
}

function toSnapshot(row: typeof listSnapshot.$inferSelect): StoredSnapshot {
  if (!HEX_RE.test(row.contentHash)) throw new TypeError("bad list_snapshot.content_hash");
  if (row.status !== "active" && row.status !== "quarantined") throw new TypeError("bad list_snapshot.status");
  return {
    id: row.id,
    source: ListSource.parse(row.source),
    contentHash: row.contentHash as Hex,
    entries: parseEntries(row.entries),
    addressCount: row.addressCount,
    status: row.status,
    fetchedAt: row.fetchedAt,
  };
}

export class PostgresListStore {
  constructor(private readonly db: HorosDb) {}

  async sourceState(source: ListSource): Promise<ListSourceState | undefined> {
    const rows = await this.db.select().from(listSource).where(eq(listSource.source, source)).limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      source: ListSource.parse(row.source),
      lastVerifiedAt: row.lastVerifiedAt,
      lastModified: row.lastModified,
      activeSnapshotId: row.activeSnapshotId,
      quarantineAlertedHash: row.quarantineAlertedHash,
    };
  }

  /** The snapshot the source's pointer references, if any. */
  async activeSnapshot(source: ListSource): Promise<StoredSnapshot | undefined> {
    const rows = await this.db
      .select({ snapshot: listSnapshot })
      .from(listSource)
      .innerJoin(listSnapshot, eq(listSnapshot.id, listSource.activeSnapshotId))
      .where(eq(listSource.source, source))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toSnapshot(row.snapshot);
  }

  /** Every source that has an active snapshot, with its freshness. */
  async activeLists(): Promise<ActiveList[]> {
    const rows = await this.db
      .select({ snapshot: listSnapshot, lastVerifiedAt: listSource.lastVerifiedAt })
      .from(listSource)
      .innerJoin(listSnapshot, eq(listSnapshot.id, listSource.activeSnapshotId))
      .where(isNotNull(listSource.activeSnapshotId))
      .orderBy(listSource.source);
    return rows.map((r) => ({ snapshot: toSnapshot(r.snapshot), lastVerifiedAt: r.lastVerifiedAt }));
  }

  async snapshotsOf(source: ListSource): Promise<StoredSnapshot[]> {
    const rows = await this.db
      .select()
      .from(listSnapshot)
      .where(eq(listSnapshot.source, source))
      .orderBy(listSnapshot.fetchedAt, listSnapshot.id);
    return rows.map(toSnapshot);
  }

  /** A successful poll with no new active content: bump `last_verified_at` (and `last_modified` if given). */
  async markVerified(source: ListSource, at: VerifiedAt): Promise<void> {
    await this.upsertSource(this.db, source, at, undefined);
  }

  /**
   * Insert `snap` as active (or reuse the active row with identical content) and move the pointer to it,
   * with the freshness bump, in one transaction. Returns the active snapshot id.
   */
  async activate(snap: NewSnapshot, at: VerifiedAt): Promise<{ readonly snapshotId: string; readonly inserted: boolean }> {
    return this.db.transaction(async (tx) => {
      await this.ensureSource(tx, snap.source);
      const r = await this.insertOrGet(tx, snap, "active");
      await this.upsertSource(tx, snap.source, at, r.snapshotId);
      return r;
    });
  }

  /** Record that the founder alert for quarantined content `contentHash` was delivered. */
  async markQuarantineAlerted(source: ListSource, contentHash: Hex): Promise<void> {
    await this.db.update(listSource).set({ quarantineAlertedHash: contentHash }).where(eq(listSource.source, source));
  }

  /**
   * Insert `snap` as quarantined (or reuse the quarantined row with identical content), keep the
   * pointer, bump freshness; one transaction. Callers pass no `lastModified` so the next poll refetches.
   */
  async quarantine(snap: NewSnapshot, at: VerifiedAt): Promise<{ readonly snapshotId: string; readonly inserted: boolean }> {
    return this.db.transaction(async (tx) => {
      await this.ensureSource(tx, snap.source);
      const r = await this.insertOrGet(tx, snap, "quarantined");
      await this.upsertSource(tx, snap.source, at, undefined);
      return r;
    });
  }

  /**
   * AD-10 (amended 2026-09-26): store `snap` as quarantined and make `merged` (the union of the
   * previous active list and `snap`) the active snapshot, bumping freshness, in one transaction.
   * Additions apply at once; removals wait for review. No `lastModified`, so the next poll refetches.
   */
  async quarantineAndMerge(
    snap: NewSnapshot,
    merged: NewSnapshot,
    at: VerifiedAt,
  ): Promise<{ readonly snapshotId: string; readonly mergedSnapshotId: string; readonly inserted: boolean }> {
    if (merged.source !== snap.source) throw new RangeError("merged snapshot must share the quarantined snapshot's source");
    return this.db.transaction(async (tx) => {
      await this.ensureSource(tx, snap.source);
      const q = await this.insertOrGet(tx, snap, "quarantined");
      const m = await this.insertOrGet(tx, merged, "active");
      await this.upsertSource(tx, snap.source, at, m.snapshotId);
      return { snapshotId: q.snapshotId, mergedSnapshotId: m.snapshotId, inserted: q.inserted };
    });
  }

  private async ensureSource(conn: Conn, source: ListSource): Promise<void> {
    await conn.insert(listSource).values({ source }).onConflictDoNothing({ target: listSource.source });
  }

  private async insertOrGet(
    conn: Conn,
    snap: NewSnapshot,
    status: SnapshotStatus,
  ): Promise<{ readonly snapshotId: string; readonly inserted: boolean }> {
    const inserted = await conn
      .insert(listSnapshot)
      .values({
        id: snap.id,
        source: snap.source,
        contentHash: snap.content.contentHash,
        entries: snap.content.entries,
        addressCount: snap.content.addressCount,
        status,
        fetchedAt: snap.fetchedAt,
      })
      .onConflictDoNothing({ target: [listSnapshot.source, listSnapshot.contentHash, listSnapshot.status] })
      .returning({ id: listSnapshot.id });
    const first = inserted[0];
    if (first !== undefined) return { snapshotId: first.id, inserted: true };
    const existing = await conn
      .select({ id: listSnapshot.id })
      .from(listSnapshot)
      .where(
        and(
          eq(listSnapshot.source, snap.source),
          eq(listSnapshot.contentHash, snap.content.contentHash),
          eq(listSnapshot.status, status),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (row === undefined) throw new Error("list_snapshot insert conflicted but no row was found");
    return { snapshotId: row.id, inserted: false };
  }

  private async upsertSource(conn: Conn, source: ListSource, at: VerifiedAt, activeSnapshotId: string | undefined): Promise<void> {
    const set: Partial<typeof listSource.$inferInsert> = { lastVerifiedAt: at.now };
    if (at.lastModified !== undefined) set.lastModified = at.lastModified;
    if (activeSnapshotId !== undefined) set.activeSnapshotId = activeSnapshotId;
    await conn
      .insert(listSource)
      .values({ source, ...set })
      .onConflictDoUpdate({ target: listSource.source, set });
  }
}
