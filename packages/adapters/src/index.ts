// @horos/adapters: the only package that talks to Postgres, chains and vendors (AD-1).
export const PACKAGE_NAME = "@horos/adapters";

export type { HorosDb } from "./postgres/db.js";
export { connectPostgres, connectPostgresSession, pingPostgres, type PostgresConnection, type PostgresSession } from "./postgres/connect.js";
export { appliedMigrationCount, bundledMigrationCount, MIGRATIONS_FOLDER, runMigrations } from "./postgres/migrate.js";
export { PostgresPolicyVersionStore, pgErrorCode, pgErrorConstraint } from "./postgres/policy-version-store.js";
export { policyVersion } from "./postgres/schema.js";
export { listSnapshot, listSource, job } from "./postgres/schema.js";
export {
  PostgresListStore,
  type ActiveList,
  type ListSourceState,
  type NewSnapshot,
  type SnapshotStatus,
  type StoredSnapshot,
  type VerifiedAt,
} from "./postgres/list-store.js";
export { PostgresJobStore, type ClaimOptions, type JobRow, type JobStatus } from "./postgres/job-store.js";
export { CsvError, parseCsv, parseSdnCsv } from "./ofac/sdn-csv.js";
export { DEFAULT_SDN_CSV_URL, httpSdnFetcher, type FetchSdn, type HttpSdnFetcherOptions, type SdnFetchResult } from "./ofac/fetch.js";
export {
  buildSnapshotContent,
  unionSnapshotContent,
  exceedsRemovalThreshold,
  removalCounts,
  removalRatio,
  type SnapshotContent,
  type SnapshotEntry,
} from "./lists/snapshot.js";
export { loadActiveListSnapshots } from "./lists/loader.js";
export {
  DEMO_LIST_LABEL,
  DEMO_LIST_PATH,
  demoListContent,
  loadDemoList,
  parseDemoList,
  readDemoList,
  type DemoListDocument,
  type LoadDemoListOptions,
} from "./lists/demo-list.js";
export { WebhookNotifier, type WebhookNotifierOptions } from "./notify/webhook.js";
export { uuidv7 } from "./ids.js";
export { decisionRecord, recordChainHead, scope, usedNonce } from "./postgres/schema.js";
export {
  PostgresRecordStore,
  ScopeMismatchError,
  exportScopeChain,
  type HorosTx,
  type ScopeRow,
  type StoredRecord,
} from "./postgres/record-store.js";
export { customer, customerWebhook, enforcedBinding, outboxIntent, accountNonce } from "./postgres/schema.js";
export { PostgresAccountStore, BindingConflictError, PROVISION_KEYS_JOB } from "./postgres/account-store.js";
export {
  PostgresOutboxStore,
  laneRoleOf,
  outboxExtraWrites,
  upsertIntent,
  type OutboxWriteContext,
} from "./postgres/outbox-store.js";
export { counterpartyMirror, writeReceipt, paidEvent, indexerCursor } from "./postgres/schema.js";
export {
  PostgresIndexerStore,
  foldMirror,
  type BoundWallet,
  type ChainPosition,
  type ConfirmIntent,
  type IntentMatch,
  type MirrorEvent,
  type MirrorState,
  type PaidEventInput,
  type PaidEventRow,
  type ReceiptStatus,
  type WriteReceiptRow,
} from "./postgres/indexer-store.js";
export { PostgresReadStore, pageLimit } from "./postgres/read-store.js";
export { policyWalletAbi } from "./chain/policy-wallet-abi.js";
export {
  chainConfig,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_MIN_BASE_FEE_WEI,
  ARC_TESTNET_USDC,
  type ChainConfig,
} from "./chain/config.js";
export { circleCall, encodeCall, type EncodedCall } from "./chain/calls.js";
export { ViemChainReader, revertName, type ViemChainReaderOptions } from "./chain/viem-reader.js";
export { cachedChainReader, type CachedChainReaderOptions } from "./chain/cached-reader.js";
export { LocalKeyChainWriter, localKeyProvisioner, type LocalKeyChainWriterOptions } from "./chain/local-writer.js";
export { recoverAccountSigner, recoverCheckSigner, type AccountTypedMessage } from "./chain/typed-data.js";
export {
  CIRCLE_BLOCKCHAIN,
  circleClientFromSdk,
  deterministicUuid,
  type CircleClient,
  type CircleContractExecutionInput,
  type CircleFeeLevel,
  type CircleSdkConfig,
  type CircleTransaction,
  type CircleTransactionState,
  type CircleWallet,
} from "./circle/client.js";
export { CircleChainWriter, type CircleChainWriterOptions } from "./circle/writer.js";
export { CircleKeyProvisioner } from "./circle/provisioner.js";
export { PostgresCheckInputs } from "./postgres/check-inputs.js";
export { createLogger, isSecretKey, LOG_LEVELS, REDACTED, redactLogValue, redactString, type LogEntry, type Logger, type LoggerOptions, type LogLevel } from "./log.js";
export {
  describeEnvFailure,
  forbidden,
  httpUrl,
  intFromString,
  parseEnv,
  postgresUrl,
  sharedEnvShape,
  type EnvProblem,
  type EnvResult,
  type RawEnv,
} from "./env.js";
