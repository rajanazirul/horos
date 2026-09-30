import { afterEach, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { PostgresListStore } from "../postgres/list-store.js";
import { freshDb, type TestClient } from "../postgres/test-db.js";
import { loadDemoList, readDemoList } from "./demo-list.js";
import { loadActiveListSnapshots } from "./loader.js";
import { buildSnapshotContent } from "./snapshot.js";

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});
async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return { ...r, store: new PostgresListStore(r.db) };
}

const T0 = new Date("2026-09-26T10:00:00.000Z");
const ADDR = `0x${"ab".repeat(20)}`;

describe("loadActiveListSnapshots", () => {
  test("returns core ListSnapshots with Map entries and lastVerifiedAt from list_source", async () => {
    const { store } = await setup();
    const c = buildSnapshotContent(new Map([[ADDR, ["EXAMPLE ENTITY"]]]));
    const sdn = await store.activate({ id: uuidv7(), source: "ofac-sdn", content: c, fetchedAt: T0 }, { now: T0 });
    await loadDemoList(store, { now: T0, newId: () => uuidv7() });
    const lists = await loadActiveListSnapshots(store);
    expect(lists.map((l) => l.source)).toEqual(["horos-demo-list", "ofac-sdn"]);
    const s = lists.find((l) => l.source === "ofac-sdn");
    expect(s).toMatchObject({ snapshotId: sdn.snapshotId, snapshotHash: c.contentHash, lastVerifiedAt: T0.getTime() });
    expect(s?.entries).toBeInstanceOf(Map);
    expect(s?.entries.get(ADDR)).toEqual(["EXAMPLE ENTITY"]);
    const demo = lists.find((l) => l.source === "horos-demo-list");
    expect(demo?.entries.size).toBe((await readDemoList()).entries.length);
  });

  test("an SDN source with no active snapshot is absent", async () => {
    const { store } = await setup();
    await store.markVerified("ofac-sdn", { now: T0 });
    expect(await loadActiveListSnapshots(store)).toEqual([]);
  });
});
