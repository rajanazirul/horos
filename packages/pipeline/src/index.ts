// @horos/pipeline: the single pipeline runner (AD-1, AD-22). Sequences one Check through injected ports;
// imports only @horos/core and @horos/schema.
export const PACKAGE_NAME = "@horos/pipeline";

export {
  ADVISORY_PUBLIC_SCOPE,
  DEFAULT_LIMIT_WRITE_WAIT_MS,
  LIMIT_WRITE_POLL_MS,
  ledgerWindowPolicy,
  runCheck,
  runShadowCheck,
  type CheckOutcome,
  type RunCheckOptions,
  type ShadowCheckOutcome,
  type ShadowPrincipal,
} from "./check.js";
export type { AdvisoryReason, CheckDeps, CheckPrincipal, LedgerEffect, LedgerWindowPolicy, MirrorView, VirtualLedger } from "./ports.js";
