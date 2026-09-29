// Worker tick (AD-20): each call ensures the current hour's `ofac-poll` job and runs it when claimable,
// then (when configured) provisions Customer keys, runs the outbox sender (Story 2.6) and then the chain-event
// indexer (Story 2.7), so a write mined since the last tick is confirmed in the same pass. Jobs are
// idempotent `(kind, window)` rows, so a second tick in the same hour does not re-poll. The entry point
// and boot loop are ./main.ts (Story 2.10).
import type { FetchSdn, PostgresJobStore, PostgresListStore } from "@horos/adapters";
import type { Notifier } from "@horos/core";
import { runIndexer, type IndexerDeps, type IndexerReport } from "./indexer.js";
import { runOfacPoll, type OfacPollOutcome } from "./ofac-poll.js";
import { runOutbox, type OutboxReport, type OutboxSenderDeps } from "./outbox-sender.js";
import { runProvisioning, type ProvisionDeps, type ProvisionReport } from "./provision.js";

export const OFAC_POLL_JOB = "ofac-poll";

/** The OFAC poll window: the UTC hour, `YYYY-MM-DDTHH`. */
export function ofacWindow(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export interface WorkerDeps {
  readonly jobs: PostgresJobStore;
  readonly lists: PostgresListStore;
  readonly fetchSdn: FetchSdn;
  readonly notifier: Notifier;
  readonly newId: () => string;
  /** Key provisioning (`provision-keys` jobs). Omitted: not run. */
  readonly provisioning?: Omit<ProvisionDeps, "jobs">;
  /** The outbox sender. Omitted: not run. */
  readonly outbox?: OutboxSenderDeps;
  /** The chain-event indexer, run after the outbox. Omitted: not run. */
  readonly indexer?: IndexerDeps;
}

export type OfacTickReport =
  | { readonly job: typeof OFAC_POLL_JOB; readonly window: string; readonly ran: false }
  | { readonly job: typeof OFAC_POLL_JOB; readonly window: string; readonly ran: true; readonly outcome: OfacPollOutcome }
  | { readonly job: typeof OFAC_POLL_JOB; readonly window: string; readonly ran: true; readonly error: string };

export type TickReport = OfacTickReport & {
  readonly provision?: ProvisionReport;
  readonly outbox?: OutboxReport;
  readonly indexer?: IndexerReport;
};

export interface Worker {
  tick(now: Date): Promise<TickReport>;
}

export function createWorker(deps: WorkerDeps): Worker {
  async function ofacTick(now: Date): Promise<OfacTickReport> {
    const window = ofacWindow(now);
    await deps.jobs.ensureJob(OFAC_POLL_JOB, window, now);
    const claimed = await deps.jobs.claimJob(OFAC_POLL_JOB, { now, window });
    if (claimed === undefined) return { job: OFAC_POLL_JOB, window, ran: false };
    try {
      const outcome = await runOfacPoll({ store: deps.lists, fetchSdn: deps.fetchSdn, notifier: deps.notifier, now, newId: deps.newId });
      const note = outcome.kind === "quarantined" && outcome.alertError !== undefined ? `founder alert failed: ${outcome.alertError}` : undefined;
      await deps.jobs.completeJob(OFAC_POLL_JOB, window, now, note);
      return { job: OFAC_POLL_JOB, window, ran: true, outcome };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await deps.jobs.failJob(OFAC_POLL_JOB, window, now, error);
      return { job: OFAC_POLL_JOB, window, ran: true, error };
    }
  }

  return {
    async tick(now) {
      const ofac = await ofacTick(now);
      const provision = deps.provisioning === undefined ? undefined : await runProvisioning({ ...deps.provisioning, jobs: deps.jobs }, now);
      const outbox = deps.outbox === undefined ? undefined : await runOutbox(deps.outbox, now);
      const indexer = deps.indexer === undefined ? undefined : await runIndexer(deps.indexer, now);
      return {
        ...ofac,
        ...(provision === undefined ? {} : { provision }),
        ...(outbox === undefined ? {} : { outbox }),
        ...(indexer === undefined ? {} : { indexer }),
      };
    },
  };
}
