import type { PGlite } from "@electric-sql/pglite";
import { keccakHex } from "@horos/schema";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { PostgresListStore } from "../postgres/list-store.js";
import { freshDb } from "../postgres/test-db.js";
import { DEMO_LIST_LABEL, DEMO_LIST_PATH, demoListContent, loadDemoList, parseDemoList, readDemoList } from "./demo-list.js";

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});
async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return { ...r, store: new PostgresListStore(r.db) };
}

const T0 = new Date("2026-09-26T10:00:00.000Z");
const T1 = new Date("2026-09-26T11:00:00.000Z");

describe("Horos Demo List fixture", () => {
  const raw = JSON.parse(readFileSync(DEMO_LIST_PATH, "utf8")) as {
    label: string;
    version: string;
    entries: { label: string; address: string; entityNames: string[] }[];
  };

  test("is clearly labelled, versioned, with at least five fictional DEMO entries", async () => {
    const doc = await readDemoList();
    expect(doc.label).toBe(DEMO_LIST_LABEL);
    expect(doc.version).not.toBe("");
    expect(doc.entries.length).toBeGreaterThanOrEqual(5);
    for (const e of doc.entries) for (const n of e.entityNames) expect(n.startsWith("DEMO")).toBe(true);
  });

  test("addresses are keccak256-derived from their labels, so no one holds the keys", () => {
    for (const e of raw.entries) {
      expect(e.address).toBe(`0x${keccakHex(`horos-demo-list:${e.label}`).slice(-40)}`);
    }
    expect(new Set(raw.entries.map((e) => e.address)).size).toBe(raw.entries.length);
  });

  test("parseDemoList rejects an unlabelled list or non-DEMO names", () => {
    expect(() => parseDemoList({ ...raw, label: "OFAC SDN" })).toThrow(TypeError);
    const bad = { ...raw, entries: [{ address: raw.entries[0]?.address, entityNames: ["REAL NAME"] }] };
    expect(() => parseDemoList(bad)).toThrow(TypeError);
  });
});

describe("loadDemoList", () => {
  test("inserts the Demo List as its own active source, idempotently", async () => {
    const { store } = await setup();
    const first = await loadDemoList(store, { now: T0, newId: () => uuidv7() });
    const again = await loadDemoList(store, { now: T1, newId: () => uuidv7() });
    expect(first.inserted).toBe(true);
    expect(again).toEqual({ snapshotId: first.snapshotId, inserted: false });
    const snaps = await store.snapshotsOf("horos-demo-list");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.contentHash).toBe(demoListContent(await readDemoList()).contentHash);
    expect(await store.activeSnapshot("ofac-sdn")).toBeUndefined();
  });
});
