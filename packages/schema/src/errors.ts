// Error envelope and PolicyWallet custom-error classification (AD-17, Consistency Conventions).
import { z } from "zod";

export const ErrorCode = z.enum([
  "validation_failed",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "shadow_closed",
  "rate_limited",
  "internal",
  "judge_unavailable",
  "unavailable",
]);
export type ErrorCode = z.output<typeof ErrorCode>;

/** Default `retryable` per error code. The envelope's `retryable` is authoritative: a call site may override it. */
export const ERROR_CODE_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  validation_failed: false,
  unauthenticated: false,
  forbidden: false,
  not_found: false,
  conflict: false,
  shadow_closed: false,
  rate_limited: true,
  internal: true,
  judge_unavailable: true,
  unavailable: true,
};

/** Default HTTP status per error code. `validation_failed` also answers 405 and 422. */
export const ERROR_CODE_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  shadow_closed: 410,
  rate_limited: 429,
  internal: 500,
  judge_unavailable: 503,
  unavailable: 503,
};

/** `{ error: { code, retryable, message } }` */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    retryable: z.boolean(),
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.output<typeof ErrorEnvelope>;

/** Build an error envelope; `retryable` defaults per code. */
export function errorEnvelope(code: ErrorCode, message: string, retryable?: boolean): ErrorEnvelope {
  return { error: { code, retryable: retryable ?? ERROR_CODE_RETRYABLE[code], message } };
}

export type ContractErrorClass = "terminal" | "retryable";

/**
 * Every custom error PolicyWallet can revert with (its own, RollingWindow's and SafeERC20's). All reverts are terminal except
 * `AlreadyRegistered`: a registration race resolves by re-reading chain and tightening instead.
 */
export const CONTRACT_ERRORS = {
  RoleConflict: "terminal",
  Unauthorized: "terminal",
  InvalidPolicy: "terminal",
  RoleVacant: "terminal",
  WithdrawFailed: "terminal",
  AlreadyRegistered: "retryable",
  CeilingExceeded: "terminal",
  NewPayeeCapReached: "terminal",
  PayeeIsContract: "terminal",
  Pinned: "terminal",
  InvalidPayee: "terminal",
  NotRegistered: "terminal",
  LimitExceeded: "terminal",
  WalletCapExceeded: "terminal",
  InvalidAmount: "terminal",
  StaleEpoch: "terminal",
  NotPinned: "terminal",
  UnpinNotRequested: "terminal",
  UnpinDelayPending: "terminal",
  // Library errors PolicyWallet can revert with (RollingWindow, OpenZeppelin SafeERC20).
  DayIndexOverflow: "terminal",
  SafeERC20FailedOperation: "terminal",
} as const satisfies Record<string, ContractErrorClass>;
export type ContractErrorName = keyof typeof CONTRACT_ERRORS;

/** Classify a revert by custom-error name. Unknown or non-contract failures are `retryable`. */
export function classifyContractError(name: string | undefined): ContractErrorClass {
  if (name !== undefined && Object.hasOwn(CONTRACT_ERRORS, name)) {
    return CONTRACT_ERRORS[name as ContractErrorName];
  }
  return "retryable";
}
