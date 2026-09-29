// The Horos Demo List (AD-10): a published, clearly labelled fixture of fictional addresses, loaded as
// its own list source. Everything it matches is `simulated` (see core `isSimulated`).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEMO_LIST_SOURCE } from "@horos/core";
import type { PostgresListStore } from "../postgres/list-store.js";
import { buildSnapshotContent, type SnapshotContent } from "./snapshot.js";

export const DEMO_LIST_LABEL = "Horos Demo List — fictional test addresses, not a real sanctions list";

/** `fixtures/horos-demo-list.json` at the repo root (same depth from `src/lists` and `dist/lists`). */
export const DEMO_LIST_PATH = fileURLToPath(new URL("../../../../fixtures/horos-demo-list.json", import.meta.url));

export interface DemoListDocument {
  readonly label: string;
  readonly version: string;
  readonly entries: readonly { readonly address: string; readonly entityNames: readonly string[] }[];
}

/** Validate a Demo List document: the exact label, a version, `DEMO`-prefixed names, EVM addresses. */
export function parseDemoList(raw: unknown): DemoListDocument {
  const d = (raw ?? {}) as { label?: unknown; version?: unknown; entries?: unknown };
  if (d.label !== DEMO_LIST_LABEL) throw new TypeError("demo list must carry the Horos Demo List label");
  if (typeof d.version !== "string" || d.version === "") throw new TypeError("demo list needs a version");
  if (!Array.isArray(d.entries) || d.entries.length === 0) throw new TypeError("demo list needs entries");
  const entries = d.entries.map((e: unknown) => {
    const { address, entityNames } = (e ?? {}) as { address?: unknown; entityNames?: unknown };
    if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/u.test(address)) throw new TypeError("demo address must be lowercase 0x+40 hex");
    if (!Array.isArray(entityNames) || entityNames.length === 0 || !entityNames.every((n) => typeof n === "string" && n.startsWith("DEMO"))) {
      throw new TypeError("demo entity names must be DEMO-prefixed strings");
    }
    return { address, entityNames: entityNames as string[] };
  });
  return { label: d.label, version: d.version, entries };
}

export async function readDemoList(path: string = DEMO_LIST_PATH): Promise<DemoListDocument> {
  return parseDemoList(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export function demoListContent(doc: DemoListDocument): SnapshotContent {
  return buildSnapshotContent(new Map(doc.entries.map((e) => [e.address, e.entityNames])));
}

export interface LoadDemoListOptions {
  readonly now: Date;
  readonly newId: () => string;
  readonly document?: DemoListDocument;
}

/**
 * Insert the Demo List as source `horos-demo-list`, active. Idempotent: identical content reuses the
 * existing snapshot row (the pointer and `last_verified_at` are refreshed).
 */
export async function loadDemoList(
  store: PostgresListStore,
  opts: LoadDemoListOptions,
): Promise<{ readonly snapshotId: string; readonly inserted: boolean }> {
  const doc = opts.document ?? (await readDemoList());
  return store.activate(
    { id: opts.newId(), source: DEMO_LIST_SOURCE, content: demoListContent(doc), fetchedAt: opts.now },
    { now: opts.now },
  );
}
