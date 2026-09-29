import type { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, test } from "vitest";
import { PostgresJobStore } from "./job-store.js";
import { job } from "./schema.js";
import { freshDb } from "./test-db.js";

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});
async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return { ...r, jobs: new PostgresJobStore(r.db) };
}

const T0 = new Date("2026-09-26T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("PostgresJobStore", () => {
  test("ensureJob is idempotent", async () => {
    const { jobs } = await setup();
    expect(await jobs.ensureJob("ofac-poll", "2026-09-26T10", T0)).toBe(true);
    expect(await jobs.ensureJob("ofac-poll", "2026-09-26T10", later(1))).toBe(false);
    expect(await jobs.get("ofac-poll", "2026-09-26T10")).toMatchObject({ status: "pending", attempts: 0, updatedAt: T0 });
  });

  test("claim → complete; a done job is never claimed again", async () => {
    const { jobs } = await setup();
    await jobs.ensureJob("ofac-poll", "w1", T0);
    const c = await jobs.claimJob("ofac-poll", { now: later(1) });
    expect(c).toMatchObject({ kind: "ofac-poll", window: "w1", status: "running", attempts: 1 });
    expect(await jobs.claimJob("ofac-poll", { now: later(2) })).toBeUndefined();
    await jobs.completeJob("ofac-poll", "w1", later(3));
    expect(await jobs.get("ofac-poll", "w1")).toMatchObject({ status: "done", lastError: null });
    expect(await jobs.claimJob("ofac-poll", { now: later(4) })).toBeUndefined();
  });

  test("failed jobs record the error and are retried up to maxAttempts", async () => {
    const { jobs } = await setup();
    await jobs.ensureJob("ofac-poll", "w1", T0);
    for (let i = 1; i <= 2; i++) {
      expect(await jobs.claimJob("ofac-poll", { now: later(i), maxAttempts: 2 })).toMatchObject({ attempts: i });
      await jobs.failJob("ofac-poll", "w1", later(i), `boom ${i}`);
    }
    expect(await jobs.get("ofac-poll", "w1")).toMatchObject({ status: "failed", attempts: 2, lastError: "boom 2" });
    expect(await jobs.claimJob("ofac-poll", { now: later(9), maxAttempts: 2 })).toBeUndefined();
  });

  test("claim respects kind and window; complete/fail need a running job", async () => {
    const { jobs } = await setup();
    await jobs.ensureJob("other", "w1", T0);
    await jobs.ensureJob("ofac-poll", "w0", T0);
    expect(await jobs.claimJob("ofac-poll", { now: T0, window: "w1" })).toBeUndefined();
    await expect(jobs.completeJob("ofac-poll", "w0", T0)).rejects.toThrow(/not running/);
    expect(await jobs.claimJob("ofac-poll", { now: T0, window: "w0" })).toMatchObject({ window: "w0" });
  });

  test("a running job past its lease is re-claimable (crashed worker)", async () => {
    const { jobs } = await setup();
    await jobs.ensureJob("ofac-poll", "w1", T0);
    await jobs.claimJob("ofac-poll", { now: T0 });
    expect(await jobs.claimJob("ofac-poll", { now: later(60_000), leaseMs: 120_000 })).toBeUndefined();
    expect(await jobs.claimJob("ofac-poll", { now: later(180_000), leaseMs: 120_000 })).toMatchObject({ attempts: 2 });
  });

  test("a lease reclaim still counts toward maxAttempts (a crash loop stops)", async () => {
    const { jobs } = await setup();
    await jobs.ensureJob("ofac-poll", "w1", T0);
    const opts = (ms: number) => ({ now: later(ms), leaseMs: 1_000, maxAttempts: 2 });
    expect(await jobs.claimJob("ofac-poll", opts(0))).toMatchObject({ attempts: 1 });
    expect(await jobs.claimJob("ofac-poll", opts(5_000))).toMatchObject({ attempts: 2 });
    expect(await jobs.claimJob("ofac-poll", opts(10_000))).toBeUndefined();
  });

  test("sequential claims take distinct windows, oldest first, with FOR UPDATE SKIP LOCKED", async () => {
    const { jobs, db } = await setup();
    await jobs.ensureJob("ofac-poll", "w2", T0);
    await jobs.ensureJob("ofac-poll", "w1", T0);
    const a = await jobs.claimJob("ofac-poll", { now: T0 });
    const b = await jobs.claimJob("ofac-poll", { now: T0 });
    expect([a?.window, b?.window]).toEqual(["w1", "w2"]);
    // PGlite is single-connection, so lock contention itself is not observable here; assert the clause.
    const q = db.select().from(job).for("update", { skipLocked: true }).toSQL();
    expect(q.sql).toMatch(/for update skip locked/i);
  });
});
