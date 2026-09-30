// @horos/sdk: the typed Horos client and PolicyWallet deploy helper (AD-17). Named exports only. Nothing here signs or builds a Human-domain
// payload (AD-12): the signers refuse every EIP-712 domain except "Horos Check" and "Horos Account".
export {
  createHoros,
  DEFAULT_CHECK_EXPIRY_SECONDS,
  type CheckInput,
  type CheckResult,
  type FetchLike,
  type GetCounterpartyOptions,
  type GetRecordOptions,
  type HorosClient,
  type HorosOptions,
  type ListCounterpartiesOptions,
  type ListRecordsOptions,
} from "./client.js";
export {
  deployPolicyWallet,
  formatDeployReport,
  type CirclePaymentSource,
  type DeployPolicyWalletOptions,
  type DeployPublicClient,
  type DeployResult,
  type EoaPaymentSource,
  type PolicyWalletRoles,
} from "./deploy.js";
export { STANDARD_PRESET, type OnchainPolicy } from "./preset.js";
export { shadowSignup, type ShadowSignupOptions, type ShadowSignupResult } from "./shadow.js";
export { type CircleContractInfo, type CircleContractsClient, type CircleFeeLevel, type CircleWalletInfo, type CircleWalletsClient } from "./circle.js";
export { HorosError, type HorosErrorInit } from "./errors.js";
export {
  circleDcwSigner,
  fromViemAccount,
  type CheckSigner,
  type CircleDcwClient,
  type CircleDcwSignerOptions,
  type SignableDomain,
  type SignableTypedData,
} from "./signer.js";
export type {
  CheckResponse,
  CounterpartyStatusPage,
  CounterpartyStatusView,
  Decision,
  DeclaredIdentity,
  ErrorCode,
  Hex,
  LimitWrite,
  RecordDetail,
  RecordPage,
  ShadowCheckResponse,
  ShadowOutcome,
  ShadowSummary,
} from "@horos/schema";
