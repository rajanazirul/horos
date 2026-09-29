// Shared response helpers for the api routes (AD-17): every error answers the `{ error: { code, retryable, message } }`
// envelope, with the HTTP status and `retryable` defaulting per code (`ERROR_CODE_HTTP_STATUS`, `ERROR_CODE_RETRYABLE`).
import { ERROR_CODE_HTTP_STATUS, errorEnvelope, type ErrorCode } from "@horos/schema";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface FailOptions {
  /** Override the code's default status (`validation_failed` also answers 405 and 422). */
  readonly status?: ContentfulStatusCode;
  /** Override the code's default `retryable`. */
  readonly retryable?: boolean;
}

/** An error envelope response. */
export function fail(c: Context, code: ErrorCode, message: string, opts: FailOptions = {}): Response {
  return c.json(errorEnvelope(code, message, opts.retryable), opts.status ?? (ERROR_CODE_HTTP_STATUS[code] as ContentfulStatusCode));
}

/** Issue paths and messages only: never the offending values (Declared Identity must not leak into logs). */
export function describeIssues(err: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(body)"}: ${i.message}`)
    .join("; ");
}
