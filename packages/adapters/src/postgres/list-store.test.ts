import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { buildSnapshotContent } from "../lists/snapshot.js";
import { PostgresListStore } from "./list-store.js";
import { freshDb } from "./test-db.js";

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});
async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return { ...r, store: new PostgresListStore(r.db) };
}

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const content = (n: number) => buildSnapshotContent(new Map(Array.from({ length: n }, (_, i) => [a(i + 1), [`E${i}`]] as const)));
const T0 = new Date("2026-09-26T10:00:00.000Z");
const T1 = new Date("2026-09-26T11:00:00.000Z");

describe("PostgresListStore", () => {
  test("activate inserts, points the source at the snapshot and records freshness", async () => {
    const { store } = await setup();
    const c = content(3);
    const r = await store.activate({ id: uuidv7(), source: "ofac-sdn", content: c, fetchedAt: T0 }, { now: T0, lastModified: "LM0" });
    expect(r.inserted).toBe(true);
    const active = await store.activeSnapshot("ofac-sdn");
    expect(active).toMatchObject({ id: r.snapshotId, contentHash: c.contentHash, addressCount: 3, status: "active" });
    expect(active?.entries).toEqual(c.entries);
    expect(await store.sourceState("ofac-sdn")).toEqual({
      source: "ofac-sdn",
      lastVerifiedAt: T0,
      lastModified: "LM0",
      activeSnapshotId: r.snapshotId,
      quarantineAlertedHash: null,
    });
  });

  test("identical content never creates a second row", async () => {
    const { store } = await setup();
    const first = await store.activate({ id: uuidv7(), source: "ofac-sdn", content: content(3), fetchedAt: T0 }, { now: T0 });
    const again = await store.activate({ id: uuidv7(), source: "ofac-sdn", content: content(3), fetchedAt: T1 }, { now: T1 });
    expect(again).toEqual({ snapshotId: first.snapshotId, inserted: false });
    expect(await store.snapshotsOf("ofac-sdn")).toHaveLength(1);
    expect((await store.sourceState("ofac-sdn"))?.lastVerifiedAt).toEqual(T1);
  });

  test("quarantine inserts without moving the pointer; markVerified touches only freshness", async () => {
    const { store } = await setup();
    const act = await store.activate({ id: uuidv7(), source: "ofac-sdn", content: content(10), fetchedAt: T0 }, { now: T0, lastModified: "LM0" });
    const q = await store.quarantine({ id: uuidv7(), source: "ofac-sdn", content: content(7), fetchedAt: T1 }, { now: T1, lastModified: "LM1" });
    expect(q.inserted).toBe(true);
    expect((await store.activeSnapshot("ofac-sdn"))?.id).toBe(act.snapshotId);
    expect((await store.snapshotsOf("ofac-sdn")).map((s) => s.status)).toEqual(["active", "quarantined"]);
    const T2 = new Date("2026-09-26T12:00:00.000Z");
    await store.markVerified("ofac-sdn", { now: T2 });
    expect(await store.sourceState("ofac-sdn")).toMatchObject({ lastVerifiedAt: T2, lastModified: "LM1", activeSnapshotId: act.snapshotId });
  });

  test("quarantineAndMerge stores the update as quarantined and activates the union in one step", async () => {
    const { store } = await setup();
    const prev = content(10);
    await store.activate({ id: uuidv7(), source: "ofac-sdn", content: prev, fetchedAt: T0 }, { now: T0, lastModified: "LM0" });
    const update = buildSnapshotContent(new Map([...prev.entries.slice(3).map((e) => [e.address, [...e.entityNames]] as const), [a(99), ["NEW"]]]));
    const merged = buildSnapshotContent(new Map([...prev.entries, ...update.entries].map((e) => [e.address, [...e.entityNames]] as const)));
    const r = await store.quarantineAndMerge(
      { id: uuidv7(), source: "ofac-sdn", content: update, fetchedAt: T1 },
      { id: uuidv7(), source: "ofac-sdn", content: merged, fetchedAt: T1 },
      { now: T1 },
    );
    expect(r.inserted).toBe(true);
    const active = await store.activeSnapshot("ofac-sdn");
    expect(active?.id).toBe(r.mergedSnapshotId);
    expect(active?.addressCount).toBe(11);
    expect(await store.sourceState("ofac-sdn")).toMatchObject({ lastVerifiedAt: T1, lastModified: "LM0" });
    expect((await store.snapshotsOf("ofac-sdn")).map((s) => s.status).sort()).toEqual(["active", "active", "quarantined"]);
  });

  test("quarantined content that later passes the threshold gets its own active row", async () => {
    const { store } = await setup();
    await store.activate({ id: uuidv7(), source: "ofac-sdn", content: content(10), fetchedAt: T0 }, { now: T0 });
    const q = await store.quarantine({ id: uuidv7(), source: "ofac-sdn", content: content(7), fetchedAt: T0 }, { now: T0 });
    const act = await store.activate({ id: uuidv7(), source: "ofac-sdn", content: content(7), fetchedAt: T1 }, { now: T1 });
    expect(act.inserted).toBe(true);
    expect(act.snapshotId).not.toBe(q.snapshotId);
    const active = await store.activeSnapshot("ofac-sdn");
    expect(active).toMatchObject({ id: act.snapshotId, status: "active", contentHash: content(7).contentHash });
    // Re-quarantining the same content reuses the quarantined row.
    const q2 = await store.quarantine({ id: uuidv7(), source: "ofac-sdn", content: content(7), fetchedAt: T1 }, { now: T1 });
    expect(q2).toEqual({ snapshotId: q.snapshotId, inserted: false });
    expect((await store.snapshotsOf("ofac-sdn")).map((s) => s.status).sort()).toEqual(["active", "active", "quarantined"]);
  });

  test("markQuarantineAlerted records the alerted content hash", async () => {
    const { store } = await setup();
    await store.markVerified("ofac-sdn", { now: T0 });
    expect((await store.sourceState("ofac-sdn"))?.quarantineAlertedHash).toBeNull();
    await store.markQuarantineAlerted("ofac-sdn", content(1).contentHash);
    expect((await store.sourceState("ofac-sdn"))?.quarantineAlertedHash).toBe(content(1).contentHash);
  });

  test("activeLists returns only sources with an active snapshot", async () => {
    const { store } = await setup();
    await store.markVerified("ofac-sdn", { now: T0 });
    expect(await store.activeLists()).toEqual([]);
    await store.activate({ id: uuidv7(), source: "horos-demo-list", content: content(2), fetchedAt: T0 }, { now: T0 });
    const lists = await store.activeLists();
    expect(lists.map((l) => l.snapshot.source)).toEqual(["horos-demo-list"]);
  });

  test("a failure inside activate rolls the whole transaction back", async () => {
    const { store } = await setup();
    await store.activate({ id: uuidv7(), source: "ofac-sdn", content: content(3), fetchedAt: T0 }, { now: T0 });
    const bad = { id: "not-a-uuid", source: "ofac-sdn" as const, content: content(4), fetchedAt: T1 };
    await expect(store.activate(bad, { now: T1 })).rejects.toThrow();
    expect((await store.sourceState("ofac-sdn"))?.lastVerifiedAt).toEqual(T0);
    expect(await store.snapshotsOf("ofac-sdn")).toHaveLength(1);
  });
});
