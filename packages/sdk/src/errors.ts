// Typed SDK failures, built from the api's error envelope (AD-17). Messages never carry keys, signatures or
// Declared Identity.
import type { ErrorCode } from "@horos/schema";

export interface HorosErrorInit {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** HTTP status of the last response, when there was one. */
  readonly status?: number;
  /** HTTP attempts made (0 when the call failed before any request). */
  readonly attempts: number;
}

export class HorosError extends Error {
  readonly code: ErrorCode;
  /** The envelope's `retryable` (authoritative): whether the same call may succeed later. */
  readonly retryable: boolean;
  readonly status?: number;
  readonly attempts: number;

  constructor(init: HorosErrorInit) {
    super(init.message);
    this.name = "HorosError";
    this.code = init.code;
    this.retryable = init.retryable;
    if (init.status !== undefined) this.status = init.status;
    this.attempts = init.attempts;
  }
}
