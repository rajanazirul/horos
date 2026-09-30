// Worker passes (AD-20, amended 2026-09-29). `fullTick` ensures the current hour's `ofac-poll` job and runs it when
// claimable, then (when configured) provisions Customer keys, runs the full outbox sender (Story 2.6) and then the
// chain-event indexer over every bound wallet (Story 2.7), so a write mined since the last tick is confirmed in the
// same pass. Jobs are idempotent `(kind, window)` rows, so a second tick in the same hour does not re-poll.
// `fastPass` is the write lane: it polls Circle for submitted writes (every `circleStatusPollMs`), claims and sends
// due outbox intents, and indexes only the wallets with a write in flight (every `inflightIndexMs`). With nothing
// in flight it makes no Circle or chain call. The caller (./main.ts, Story 2.10) never runs two passes at once.
import type { FetchSdn, PostgresJobStore, PostgresListStore } from "@horos/adapters";
import type { Notifier } from "@horos/core";
import { createIndexer, type IndexerDeps, type IndexerReport, type WalletIndexReport } from "./indexer.js";
import { runOfacPoll, type OfacPollOutcome } from "./ofac-poll.js";
import { createOutboxSender, type IntentOutcome, type OutboxReport, type OutboxSenderDeps } from "./outbox-sender.js";
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
  /** Fast-lane cadences. Defaults: Circle status poll 500 ms, in-flight indexer 1000 ms. */
  readonly cadences?: { readonly circleStatusPollMs?: number; readonly inflightIndexMs?: number };
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

/** One fast pass. `polled` is present only when the Circle poll was due; `indexer` only when a wallet was indexed. */
export interface FastPassReport {
  readonly outbox?: { readonly polled?: OutboxReport["polled"]; readonly processed: readonly IntentOutcome[] };
  readonly indexer?: { readonly wallets: readonly WalletIndexReport[] };
}

export interface Worker {
  fullTick(now: Date): Promise<TickReport>;
  fastPass(now: Date): Promise<FastPassReport>;
}

export const DEFAULT_CIRCLE_STATUS_POLL_MS = 500;
export const DEFAULT_INFLIGHT_INDEX_MS = 1000;

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

  const sender = deps.outbox === undefined ? undefined : createOutboxSender(deps.outbox);
  // One indexer for both lanes, so a wallet's rate-limit cooldown holds across full ticks and fast passes.
  const indexerLane = deps.indexer === undefined ? undefined : createIndexer(deps.indexer);
  const pollMs = deps.cadences?.circleStatusPollMs ?? DEFAULT_CIRCLE_STATUS_POLL_MS;
  const indexMs = deps.cadences?.inflightIndexMs ?? DEFAULT_INFLIGHT_INDEX_MS;
  // When the fast lane last polled Circle / indexed; a full tick does both, so it resets them too.
  let lastPollAt = Number.NEGATIVE_INFINITY;
  let lastIndexAt = Number.NEGATIVE_INFINITY;

  return {
    async fastPass(now) {
      const t = now.getTime();
      let outbox: FastPassReport["outbox"];
      if (sender !== undefined) {
        let polled: OutboxReport["polled"] | undefined;
        if (t - lastPollAt >= pollMs) {
          lastPollAt = t;
          // Only submitted intents without a tx hash are polled: none in flight, no Circle call.
          polled = await sender.poll(now);
        }
        const processed = await sender.claim(now);
        outbox = { ...(polled === undefined ? {} : { polled }), processed };
      }
      let indexer: FastPassReport["indexer"];
      if (indexerLane !== undefined && t - lastIndexAt >= indexMs) {
        lastIndexAt = t;
        // Only wallets with a sending or submitted intent: none in flight, no chain call.
        const r = await indexerLane.runInflight(now);
        if (r.wallets.length > 0) indexer = r;
      }
      return { ...(outbox === undefined ? {} : { outbox }), ...(indexer === undefined ? {} : { indexer }) };
    },

    async fullTick(now) {
      const ofac = await ofacTick(now);
      const provision = deps.provisioning === undefined ? undefined : await runProvisioning({ ...deps.provisioning, jobs: deps.jobs }, now);
      const outbox = sender === undefined ? undefined : await sender.run(now);
      if (sender !== undefined) lastPollAt = now.getTime();
      const indexer = indexerLane === undefined ? undefined : await indexerLane.run(now);
      if (indexerLane !== undefined) lastIndexAt = now.getTime();
      return {
        ...ofac,
        ...(provision === undefined ? {} : { provision }),
        ...(outbox === undefined ? {} : { outbox }),
        ...(indexer === undefined ? {} : { indexer }),
      };
    },
  };
}
