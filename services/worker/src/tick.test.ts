import type { PGlite } from "@electric-sql/pglite";
import {
  PostgresJobStore,
  PostgresListStore,
  loadActiveListSnapshots,
  loadDemoList,
  readDemoList,
  uuidv7,
  type FetchSdn,
  type SdnFetchResult,
} from "@horos/adapters";
import { STANDARD_PRESET, evaluate, isSimulated, type FounderAlert, type Notifier } from "@horos/core";
import { drizzle } from "drizzle-orm/pglite";
import { migratedClient, migratedDump } from "./migrated-db.test-helpers.js";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createWorker, ofacWindow, OFAC_POLL_JOB } from "./tick.js";

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/ofac/${name}`, import.meta.url), "utf8");
const SAMPLE = fixture("sdn-sample.csv");
const SAMPLE_30 = fixture("sdn-sample-30pct-removed.csv");
const A8 = `0x${"a8".padStart(40, "0")}`;
const SHARED = "0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345601";
const PAYEE = "0x1111111111111111111111111111111111111111";

const T0 = new Date("2026-09-26T10:05:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (h: number, extraMs = 0) => new Date(T0.getTime() + h * HOUR + extraMs);

// Migrate once for the file, outside any single test's timeout.
beforeAll(async () => {
  await migratedDump();
});

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

class RecordingNotifier implements Notifier {
  readonly alerts: FounderAlert[] = [];
  /** `failures` = number of initial calls that reject (Infinity = always). */
  constructor(private failures = 0) {}
  async notify(alert: FounderAlert): Promise<void> {
    this.alerts.push(alert);
    if (this.failures > 0) {
      this.failures--;
      throw new Error("webhook down");
    }
  }
}

/** A scripted fetcher: each call shifts the next response (or throws it). */
function scripted(...responses: (SdnFetchResult | Error)[]) {
  const seen: (string | undefined)[] = [];
  const fetchSdn: FetchSdn = async (ims) => {
    seen.push(ims);
    const r = responses.shift();
    if (r === undefined) throw new Error("unexpected fetch");
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchSdn, seen };
}

const ok = (body: string, lastModified = "Fri, 25 Sep 2026 12:00:00 GMT"): SdnFetchResult => ({ status: 200, body, lastModified });

async function setup(fetchSdn: FetchSdn, notifier: Notifier = new RecordingNotifier()) {
  const client = await migratedClient();
  clients.push(client);
  const db = drizzle(client);
  const lists = new PostgresListStore(db);
  const jobs = new PostgresJobStore(db);
  const worker = createWorker({ jobs, lists, fetchSdn, notifier, newId: () => uuidv7() });
  return { client, lists, jobs, worker };
}

describe("tick / runOfacPoll", () => {
  test("first fetch: every EVM address active, lowercased; freshness and Last-Modified set", async () => {
    const f = scripted(ok(SAMPLE));
    const { worker, lists, jobs } = await setup(f.fetchSdn);
    const r = await worker.tick(T0);
    expect(r).toMatchObject({ ran: true, outcome: { kind: "activated", addressCount: 10 } });
    expect(f.seen).toEqual([undefined]);
    const active = await lists.activeSnapshot("ofac-sdn");
    expect(active?.addressCount).toBe(10);
    expect(active?.entries.map((e) => e.address)).toContain(SHARED);
    expect(active?.entries.map((e) => e.address)).toContain(`0x${"a4".padStart(40, "0")}`); // empty ticker
    expect(active?.entries.map((e) => e.address)).toContain(`0x${"a3".padStart(40, "0")}`); // ARB
    expect(await lists.sourceState("ofac-sdn")).toMatchObject({ lastVerifiedAt: T0, lastModified: "Fri, 25 Sep 2026 12:00:00 GMT" });
    expect(await jobs.get(OFAC_POLL_JOB, ofacWindow(T0))).toMatchObject({ status: "done", attempts: 1 });
  });

  test("304: only last_verified_at changes, If-Modified-Since is sent", async () => {
    const f = scripted(ok(SAMPLE), { status: 304 });
    const { worker, lists } = await setup(f.fetchSdn);
    await worker.tick(T0);
    const before = await lists.activeSnapshot("ofac-sdn");
    expect(await worker.tick(at(1))).toMatchObject({ outcome: { kind: "not-modified" } });
    expect(f.seen[1]).toBe("Fri, 25 Sep 2026 12:00:00 GMT");
    expect(await lists.snapshotsOf("ofac-sdn")).toHaveLength(1);
    expect(await lists.sourceState("ofac-sdn")).toMatchObject({
      lastVerifiedAt: at(1),
      lastModified: "Fri, 25 Sep 2026 12:00:00 GMT",
      activeSnapshotId: before?.id,
    });
  });

  test("same content: no new row, freshness bumped", async () => {
    // The second body differs only by the trailing 0x1A end-of-file byte.
    const withoutEof = SAMPLE.slice(0, -1);
    expect(SAMPLE.charCodeAt(SAMPLE.length - 1)).toBe(0x1a);
    expect(withoutEof).not.toContain("\u001a");
    const f = scripted(ok(SAMPLE), ok(withoutEof, "Sat, 26 Sep 2026 12:00:00 GMT"));
    const { worker, lists } = await setup(f.fetchSdn);
    await worker.tick(T0);
    expect(await worker.tick(at(1))).toMatchObject({ outcome: { kind: "unchanged" } });
    expect(await lists.snapshotsOf("ofac-sdn")).toHaveLength(1);
    expect(await lists.sourceState("ofac-sdn")).toMatchObject({ lastVerifiedAt: at(1), lastModified: "Sat, 26 Sep 2026 12:00:00 GMT" });
  });

  test("small change (1 of 10 removed): new active snapshot, pointer moved", async () => {
    const oneRemoved = SAMPLE.replace(`Digital Currency Address - ETH ${A8}; `, "");
    expect(oneRemoved).not.toBe(SAMPLE);
    const f = scripted(ok(SAMPLE), ok(oneRemoved));
    const notifier = new RecordingNotifier();
    const { worker, lists } = await setup(f.fetchSdn, notifier);
    await worker.tick(T0);
    const first = await lists.activeSnapshot("ofac-sdn");
    expect(await worker.tick(at(1))).toMatchObject({ outcome: { kind: "activated", addressCount: 9 } });
    const now = await lists.activeSnapshot("ofac-sdn");
    expect(now?.id).not.toBe(first?.id);
    expect(now?.entries.some((e) => e.address === A8)).toBe(false);
    expect(notifier.alerts).toEqual([]);
  });

  test("big removal (3 of 10): quarantined, previous stays active, one alert", async () => {
    const f = scripted(ok(SAMPLE), ok(SAMPLE_30, "Sat, 26 Sep 2026 12:00:00 GMT"));
    const notifier = new RecordingNotifier();
    const { worker, lists } = await setup(f.fetchSdn, notifier);
    await worker.tick(T0);
    const first = await lists.activeSnapshot("ofac-sdn");
    const r = await worker.tick(at(1));
    expect(r).toMatchObject({ outcome: { kind: "quarantined", removed: 3, total: 10, alerted: true } });
    expect((await lists.activeSnapshot("ofac-sdn"))?.id).toBe(first?.id);
    expect((await lists.snapshotsOf("ofac-sdn")).map((s) => s.status)).toEqual(["active", "quarantined"]);
    // Freshness moves, but the previous Last-Modified is kept so the next poll refetches.
    expect(await lists.sourceState("ofac-sdn")).toMatchObject({
      lastVerifiedAt: at(1),
      lastModified: "Fri, 25 Sep 2026 12:00:00 GMT",
    });
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]).toMatchObject({ kind: "list-quarantined", source: "ofac-sdn" });
    expect(Object.keys(notifier.alerts[0] ?? {}).sort()).toEqual(["kind", "message", "source"]);
  });

  test("big removal with additions: the union is active, so new designations block now and removals still block (AD-10 amended)", async () => {
    const NEW = `0x${"b1".padStart(40, "0")}`;
    const withAddition =
      (SAMPLE_30.endsWith("\u001a") ? SAMPLE_30.slice(0, -1) : SAMPLE_30).replace(/\r?\n?$/u, "\n") +
      `90099,"NEW DESIGNATION EXAMPLE","-0- ","CYBER2","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","Digital Currency Address - ETH ${NEW};"\n`;
    const f = scripted(ok(SAMPLE), ok(withAddition, "Sat, 26 Sep 2026 12:00:00 GMT"));
    const notifier = new RecordingNotifier();
    const { worker, lists } = await setup(f.fetchSdn, notifier);
    await worker.tick(T0);
    const first = await lists.activeSnapshot("ofac-sdn");
    const r = await worker.tick(at(1));
    expect(r).toMatchObject({ outcome: { kind: "quarantined", removed: 3, total: 10, added: 1, alerted: true } });
    const active = await lists.activeSnapshot("ofac-sdn");
    expect(active?.id).not.toBe(first?.id);
    expect(r).toMatchObject({ outcome: { mergedSnapshotId: active?.id } });
    expect(active?.addressCount).toBe(11);
    expect((await lists.snapshotsOf("ofac-sdn")).map((s) => s.status).sort()).toEqual(["active", "active", "quarantined"]);
    expect(await lists.sourceState("ofac-sdn")).toMatchObject({ lastModified: "Fri, 25 Sep 2026 12:00:00 GMT" });
    expect(notifier.alerts[0]?.message).toMatch(/1 new address\(es\) are enforced now/);

    const snaps = await loadActiveListSnapshots(lists);
    const removedAddress = first?.entries.find((e) => !withAddition.toLowerCase().includes(e.address))?.address;
    expect(removedAddress).toBeDefined();
    for (const addr of [NEW, removedAddress ?? ""]) {
      const ev = evaluate({
        counterparty: addr,
        amount: 50_000_000n,
        now: at(1).getTime(),
        lists: snaps,
        chainState: "live",
        hasHistory: false,
        identityBindings: [],
        policy: STANDARD_PRESET.offchain,
      });
      expect(ev.decision).toBe("block");
      expect(isSimulated(ev)).toBe(false);
    }
  });

  test("the same quarantined body again: refetched, no second alert, no new row", async () => {
    const f = scripted(ok(SAMPLE), ok(SAMPLE_30, "Sat, 26 Sep 2026 12:00:00 GMT"), ok(SAMPLE_30, "Sat, 26 Sep 2026 12:00:00 GMT"));
    const notifier = new RecordingNotifier();
    const { worker, lists } = await setup(f.fetchSdn, notifier);
    await worker.tick(T0);
    await worker.tick(at(1));
    const r = await worker.tick(at(2));
    expect(f.seen[2]).toBe("Fri, 25 Sep 2026 12:00:00 GMT");
    expect(r).toMatchObject({ outcome: { kind: "quarantined", alerted: false } });
    expect(notifier.alerts).toHaveLength(1);
    expect(await lists.snapshotsOf("ofac-sdn")).toHaveLength(2);
    expect((await lists.sourceState("ofac-sdn"))?.lastVerifiedAt).toEqual(at(2));
  });

  test("a failed quarantine alert is retried on the next poll and then sent once", async () => {
    const f = scripted(ok(SAMPLE), ok(SAMPLE_30), ok(SAMPLE_30), ok(SAMPLE_30));
    const notifier = new RecordingNotifier(1);
    const { worker, lists } = await setup(f.fetchSdn, notifier);
    await worker.tick(T0);
    expect(await worker.tick(at(1))).toMatchObject({ outcome: { kind: "quarantined", alerted: false, alertError: "Error: webhook down" } });
    expect((await lists.sourceState("ofac-sdn"))?.quarantineAlertedHash).toBeNull();
    expect(await worker.tick(at(2))).toMatchObject({ outcome: { kind: "quarantined", alerted: true } });
    expect(await worker.tick(at(3))).toMatchObject({ outcome: { kind: "quarantined", alerted: false } });
    expect(notifier.alerts).toHaveLength(2);
    expect(await lists.snapshotsOf("ofac-sdn")).toHaveLength(2);
  });

  test("big removal with a failing alert: recorded on the job, not thrown", async () => {
    const f = scripted(ok(SAMPLE), ok(SAMPLE_30));
    const { worker, jobs, lists } = await setup(f.fetchSdn, new RecordingNotifier(Infinity));
    await worker.tick(T0);
    const r = await worker.tick(at(1));
    expect(r).toMatchObject({ ran: true, outcome: { kind: "quarantined", alertError: "Error: webhook down" } });
    expect(await jobs.get(OFAC_POLL_JOB, ofacWindow(at(1)))).toMatchObject({
      status: "done",
      lastError: "founder alert failed: Error: webhook down",
    });
    expect((await lists.snapshotsOf("ofac-sdn")).map((s) => s.status)).toEqual(["active", "quarantined"]);
  });

  test.each([
    ["a network error", new TypeError("fetch failed")],
    ["HTTP 500", { status: 500 } as SdnFetchResult],
  ])("fetch failure (%s): nothing bumped, job failed with the error", async (_name, failure) => {
    const f = scripted(ok(SAMPLE), failure);
    const { worker, lists, jobs } = await setup(f.fetchSdn);
    await worker.tick(T0);
    const r = await worker.tick(at(1));
    expect(r).toMatchObject({ ran: true });
    expect("error" in r && r.error).toMatch(/fetch/i);
    expect(await lists.sourceState("ofac-sdn")).toMatchObject({ lastVerifiedAt: T0, lastModified: "Fri, 25 Sep 2026 12:00:00 GMT" });
    expect(await lists.snapshotsOf("ofac-sdn")).toHaveLength(1);
    const job = await jobs.get(OFAC_POLL_JOB, ofacWindow(at(1)));
    expect(job?.status).toBe("failed");
    expect(job?.lastError).toMatch(/fetch/i);
  });

  test("empty parse while the active snapshot has addresses: a failure, no bump", async () => {
    const f = scripted(ok(SAMPLE), ok('1,"NOBODY","-0- ","P","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- "\n'));
    const { worker, lists, jobs } = await setup(f.fetchSdn);
    await worker.tick(T0);
    const r = await worker.tick(at(1));
    expect("error" in r && r.error).toMatch(/0 EVM addresses/);
    expect((await lists.sourceState("ofac-sdn"))?.lastVerifiedAt).toEqual(T0);
    expect(await lists.snapshotsOf("ofac-sdn")).toHaveLength(1);
    expect((await jobs.get(OFAC_POLL_JOB, ofacWindow(at(1))))?.status).toBe("failed");
  });

  test("empty parse on the very first poll: a failure, nothing activated, SDN stays absent (stale)", async () => {
    const f = scripted(ok('1,"NOBODY","-0- ","P","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- "\n'));
    const { worker, lists, jobs } = await setup(f.fetchSdn);
    const r = await worker.tick(T0);
    expect("error" in r && r.error).toMatch(/0 EVM addresses/);
    expect(await lists.sourceState("ofac-sdn")).toBeUndefined();
    expect(await loadActiveListSnapshots(lists)).toEqual([]);
    expect((await jobs.get(OFAC_POLL_JOB, ofacWindow(T0)))?.status).toBe("failed");
  });

  test("a malformed CSV is a failure", async () => {
    const f = scripted(ok('1,"unterminated'));
    const { worker, lists } = await setup(f.fetchSdn);
    const r = await worker.tick(T0);
    expect("error" in r && r.error).toMatch(/parse failed/);
    expect(await lists.sourceState("ofac-sdn")).toBeUndefined();
  });

  test("tick twice in the same hour runs the poll once; the next hour runs again", async () => {
    const f = scripted(ok(SAMPLE), { status: 304 });
    const { worker } = await setup(f.fetchSdn);
    expect(await worker.tick(T0)).toMatchObject({ ran: true });
    expect(await worker.tick(at(0, 30 * 60 * 1000))).toEqual({ job: OFAC_POLL_JOB, window: "2026-09-26T10", ran: false });
    expect(f.seen).toHaveLength(1);
    expect(await worker.tick(at(1))).toMatchObject({ ran: true, window: "2026-09-26T11" });
    expect(f.seen).toHaveLength(2);
  });

  test("ofacWindow is the UTC hour", () => {
    expect(ofacWindow(new Date("2026-09-26T23:59:59.999Z"))).toBe("2026-09-26T23");
  });
});

describe("end to end through the loader and core evaluate", () => {
  const input = (counterparty: string, lists: Awaited<ReturnType<typeof loadActiveListSnapshots>>, now: Date) =>
    evaluate({
      counterparty,
      amount: 50_000_000n,
      now: now.getTime(),
      lists,
      chain: {
        view: {
          cpRemaining: 0n,
          walletRemaining: 5_000_000_000n,
          newPayeeRemaining: 10n,
          limit: 0n,
          pinned: false,
          registered: false,
          humanSet: false,
          humanEpoch: 0n,
        },
        payeeIsContract: false,
        firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling,
      },
      chainState: "live",
      hasHistory: false,
      identityBindings: [],
      policy: STANDARD_PRESET.offchain,
    });

  test("stale: last_verified_at 25h ago → hold 'sanctions list stale' on first contact", async () => {
    const f = scripted(ok(SAMPLE));
    const { worker, lists } = await setup(f.fetchSdn);
    await worker.tick(T0);
    const e = input(PAYEE, await loadActiveListSnapshots(lists), at(25));
    expect(e.decision).toBe("hold");
    expect(e.decisiveRule).toBe("sanctions-list-stale");
    expect(e.reason).toMatch(/sanctions list stale/);
    // Fresh (1h) the same payee is not held for staleness.
    expect(input(PAYEE, await loadActiveListSnapshots(lists), at(1)).decisiveRule).not.toBe("sanctions-list-stale");
  });

  test("an SDN match blocks and is not simulated", async () => {
    const f = scripted(ok(SAMPLE));
    const { worker, lists } = await setup(f.fetchSdn);
    await worker.tick(T0);
    const e = input(SHARED.toUpperCase().replace("0X", "0x"), await loadActiveListSnapshots(lists), at(1));
    expect(e.decision).toBe("block");
    expect(isSimulated(e)).toBe(false);
    expect(e.hardRules.find((h) => h.source === "ofac-sdn")?.entityNames).toEqual([
      "EXAMPLE CYBER GROUP, LTD.",
      "SYNTHETIC MIXER SERVICE",
    ]);
  });

  test("Demo match: block, isSimulated true, the SDN snapshot is not involved", async () => {
    const f = scripted(ok(SAMPLE));
    const { worker, lists } = await setup(f.fetchSdn);
    await worker.tick(T0);
    await loadDemoList(lists, { now: T0, newId: () => uuidv7() });
    const demoAddr = (await readDemoList()).entries[0]?.address ?? "";
    const e = input(demoAddr, await loadActiveListSnapshots(lists), at(1));
    expect(e.decision).toBe("block");
    expect(isSimulated(e)).toBe(true);
    expect(e.hardRules.find((h) => h.source === "ofac-sdn")?.matched).toBe(false);
    expect(e.hardRules.find((h) => h.source === "horos-demo-list")?.matched).toBe(true);
  });
});
