// @horos/worker: outbox, indexer, list polls and watch jobs (AD-20). The boot loop is ./main.ts and the migrate
// command ./migrate.ts (Story 2.10).
export const PACKAGE_NAME = "@horos/worker";

export { OFAC_SOURCE, OfacPollError, runOfacPoll, type OfacPollDeps, type OfacPollOutcome } from "./ofac-poll.js";
export {
  OFAC_POLL_JOB,
  createWorker,
  ofacWindow,
  type OfacTickReport,
  type TickReport,
  type Worker,
  type WorkerDeps,
} from "./tick.js";
export { runProvisioning, type ProvisionDeps, type ProvisionReport } from "./provision.js";
export {
  createOutboxSender,
  runOutbox,
  type IntentOutcome,
  type OutboxReport,
  type OutboxSenderDeps,
} from "./outbox-sender.js";
export {
  createIndexer,
  findDeployBlock,
  runIndexer,
  UNRECOGNISED_WRITE_ALERT_JOB,
  type IndexerDeps,
  type IndexerReport,
  type WalletIndexReport,
} from "./indexer.js";
