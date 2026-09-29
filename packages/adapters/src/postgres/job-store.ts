// Idempotent worker jobs (AD-20): rows keyed `(kind, window)`, claimed with `FOR UPDATE SKIP LOCKED`.
// Transitions: ensure (insert pending) → claim (→ running) → complete (→ done) | fail (→ failed).
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import type { HorosDb } from "./db.js";
import { job } from "./schema.js";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobRow {
  readonly kind: string;
  readonly window: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

export interface ClaimOptions {
  readonly now: Date;
  /** Claim only this window (e.g. the current hour). */
  readonly window?: string;
  /** A `failed` row is re-claimable while `attempts` is below this. Default 3. */
  readonly maxAttempts?: number;
  /** A `running` row untouched for this long is presumed crashed and re-claimable (below `maxAttempts`). Default 15 min. */
  readonly leaseMs?: number;
}

const MAX_ERROR_LENGTH = 1000;

function toRow(r: typeof job.$inferSelect): JobRow {
  const s = r.status;
  if (s !== "pending" && s !== "running" && s !== "done" && s !== "failed") throw new TypeError("bad job.status");
  return { kind: r.kind, window: r.window, status: s, attempts: r.attempts, lastError: r.lastError, updatedAt: r.updatedAt };
}

export class PostgresJobStore {
  constructor(private readonly db: HorosDb) {}

  /** Insert a pending `(kind, window)` job; a no-op if it already exists. Returns true when inserted. */
  async ensureJob(kind: string, window: string, now: Date): Promise<boolean> {
    const r = await this.db
      .insert(job)
      .values({ kind, window, status: "pending", attempts: 0, updatedAt: now })
      .onConflictDoNothing({ target: [job.kind, job.window] })
      .returning({ kind: job.kind });
    return r.length > 0;
  }

  /**
   * Claim one runnable job of `kind` (pending, failed below `maxAttempts`, or running past its lease),
   * skipping rows another worker has locked. Moves it to `running` and counts the attempt.
   */
  async claimJob(kind: string, opts: ClaimOptions): Promise<JobRow | undefined> {
    const maxAttempts = opts.maxAttempts ?? 3;
    const leaseCutoff = new Date(opts.now.getTime() - (opts.leaseMs ?? 15 * 60 * 1000));
    return this.db.transaction(async (tx) => {
      const runnable = or(
        eq(job.status, "pending"),
        and(eq(job.status, "failed"), lt(job.attempts, maxAttempts)),
        and(eq(job.status, "running"), lt(job.updatedAt, leaseCutoff), lt(job.attempts, maxAttempts)),
      );
      const where = opts.window === undefined ? and(eq(job.kind, kind), runnable) : and(eq(job.kind, kind), eq(job.window, opts.window), runnable);
      const picked = await tx
        .select({ kind: job.kind, window: job.window })
        .from(job)
        .where(where)
        .orderBy(asc(job.window))
        .limit(1)
        .for("update", { skipLocked: true });
      const p = picked[0];
      if (p === undefined) return undefined;
      const updated = await tx
        .update(job)
        .set({ status: "running", attempts: sql`${job.attempts} + 1`, updatedAt: opts.now })
        .where(and(eq(job.kind, p.kind), eq(job.window, p.window)))
        .returning();
      const row = updated[0];
      return row === undefined ? undefined : toRow(row);
    });
  }

  /** running → done. `note` records a non-fatal problem (e.g. a failed alert) in `last_error`. */
  async completeJob(kind: string, window: string, now: Date, note?: string): Promise<void> {
    await this.transition(kind, window, "done", now, note === undefined ? null : note.slice(0, MAX_ERROR_LENGTH));
  }

  /** running → failed, recording the error message. */
  async failJob(kind: string, window: string, now: Date, error: string): Promise<void> {
    await this.transition(kind, window, "failed", now, error.slice(0, MAX_ERROR_LENGTH));
  }

  /** A `failed` job (e.g. out of attempts) back to `pending` with a fresh attempt budget. True when reset. */
  async resetFailed(kind: string, window: string, now: Date): Promise<boolean> {
    const r = await this.db
      .update(job)
      .set({ status: "pending", attempts: 0, updatedAt: now })
      .where(and(eq(job.kind, kind), eq(job.window, window), eq(job.status, "failed")))
      .returning({ kind: job.kind });
    return r.length > 0;
  }

  async get(kind: string, window: string): Promise<JobRow | undefined> {
    const rows = await this.db.select().from(job).where(and(eq(job.kind, kind), eq(job.window, window))).limit(1);
    const r = rows[0];
    return r === undefined ? undefined : toRow(r);
  }

  private async transition(kind: string, window: string, status: "done" | "failed", now: Date, lastError: string | null) {
    const r = await this.db
      .update(job)
      .set({ status, lastError, updatedAt: now })
      .where(and(eq(job.kind, kind), eq(job.window, window), eq(job.status, "running")))
      .returning({ kind: job.kind });
    if (r.length === 0) throw new Error(`job ${kind}/${window} is not running`);
  }
}
