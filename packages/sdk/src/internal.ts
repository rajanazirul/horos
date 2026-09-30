// Internal helpers shared by the check client and the deploy helper: input errors, nonces and expiries, a signer
// wrapper that checks every signature recovers to the signer, and the HTTP attempt / retry loop over the api's error
// envelope (AD-17). Not exported from the package index.
import { ErrorEnvelope, toWireTime, type ErrorCode, type Hex } from "@horos/schema";
import { recoverTypedDataAddress } from "viem";
import { HorosError } from "./errors.js";
import type { CheckSigner, SignableTypedData } from "./signer.js";

/** Retries stop this long before the envelope expires, so a resend never arrives expired. */
export const RETRY_EXPIRY_MARGIN_MS = 5_000;
export const RETRY_INITIAL_BACKOFF_MS = 250;
export const RETRY_MAX_BACKOFF_MS = 4_000;
/** Each HTTP attempt is aborted after this long (or the remaining budget, if smaller), so a stalled connection is retried. */
const ATTEMPT_TIMEOUT_MS = 30_000;

/** The subset of `fetch` the SDK uses (injectable for tests and custom transports). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface RequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export type Parse<T> = (json: unknown) => { success: true; data: T } | { success: false };

export const invalid = (message: string): HorosError => new HorosError({ code: "validation_failed", message, retryable: false, attempts: 0 });

/** Issue paths and messages only, never the offending values. */
export function describe(err: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return err.issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(value)"}: ${i.message}`).join("; ");
}

export function randomBytes32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

/** A whole-second expiry `seconds` from `nowMs`, rounded down so it never exceeds the api's window. */
export function expiryAt(nowMs: number, seconds: number): { ms: number; wire: string } {
  const ms = Math.floor((nowMs + seconds * 1000) / 1000) * 1000;
  return { ms, wire: toWireTime(new Date(ms)) };
}

export function parseBaseUrl(raw: string): string {
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw invalid("baseUrl must be an absolute http(s) URL");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw invalid("baseUrl must be an absolute http(s) URL");
  return raw.replace(/\/+$/, "");
}

/** Sign, then make sure the signature recovers to the signer: otherwise the api would silently refuse or run advisory. */
export async function signVerified(signer: CheckSigner, signerAddress: Hex, typedData: SignableTypedData): Promise<Hex> {
  let signature: Hex;
  try {
    signature = await signer.signTypedData(typedData);
  } catch (err) {
    // Only the error's name: a Circle client error can carry request headers (the API key).
    throw new HorosError({ code: "unauthenticated", message: `the signer failed: ${err instanceof Error ? err.name : "error"}`, retryable: false, attempts: 0 });
  }
  const mismatch = () =>
    new HorosError({ code: "unauthenticated", message: "the signature does not recover to the signer's address", retryable: false, attempts: 0 });
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({ ...typedData, signature } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
  } catch {
    throw mismatch();
  }
  if (recovered.toLowerCase() !== signerAddress) throw mismatch();
  return signature;
}

export interface AttemptFailure {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** True when the failure is the api's error envelope (the api answered and said what happened). */
  readonly envelope?: boolean;
}

export type AttemptResult<T> = { ok: true; value: T; status: number } | { ok: false; failure: AttemptFailure };

function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

export interface Transport {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * One HTTP request. A status in `okStatuses` (default 200) is parsed with `parse`; a success status whose body does
   * not parse is a non-retryable `unavailable` (the api may already have acted). Anything else is read as the error
   * envelope, whose `retryable` is authoritative; network failures and non-envelope bodies are retryable `unavailable`.
   */
  attempt<T>(url: string, init: RequestInit, parse: Parse<T>, deadlineMs: number, okStatuses?: readonly number[]): Promise<AttemptResult<T>>;
  /** Send the same request until it succeeds, fails non-retryably, or the next try would pass `deadlineMs`. */
  sendWithRetry<T>(url: string, init: RequestInit, parse: Parse<T>, deadlineMs: number, giveUpReason: string): Promise<T>;
  /**
   * For requests that are not idempotent (no nonce protects a resend): retry only on a retryable error envelope, which
   * the api sends before writing anything. A network failure, timeout, non-JSON or non-envelope answer may come after
   * the api acted, so it throws at once as a non-retryable `unavailable` whose message ends with `uncertain`.
   */
  sendRetryingEnvelopesOnly<T>(url: string, init: RequestInit, parse: Parse<T>, deadlineMs: number, giveUpReason: string, uncertain: string): Promise<T>;
}

/** The error for a failed attempt, after `attempts` tries. */
export function failureError(f: AttemptFailure, attempts: number, suffix = ""): HorosError {
  return new HorosError({
    code: f.code,
    message: `${f.message}${suffix}`,
    retryable: f.retryable,
    ...(f.status === undefined ? {} : { status: f.status }),
    attempts,
  });
}

export function createTransport(opts: { fetch?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void> }): Transport {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function attempt<T>(url: string, init: RequestInit, parse: Parse<T>, deadlineMs: number, okStatuses: readonly number[] = [200]): Promise<AttemptResult<T>> {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, deadlineMs - now()))) });
      text = await res.text();
    } catch (err) {
      return { ok: false, failure: { code: "unavailable", retryable: true, message: `request failed: ${err instanceof Error ? err.name : "error"}` } };
    }
    let json: unknown;
    let isJson = true;
    try {
      json = JSON.parse(text);
    } catch {
      isJson = false;
    }
    if (okStatuses.includes(res.status)) {
      const parsed = isJson ? parse(json) : { success: false as const };
      if (parsed.success) return { ok: true, value: parsed.data, status: res.status };
      // Not retried: on /v1/check a 200 means the record was written and the nonce consumed, so a resend would be a replay.
      return { ok: false, failure: { code: "unavailable", retryable: false, status: res.status, message: `HTTP ${res.status}: response does not match the wire schema` } };
    }
    if (!isJson) {
      return { ok: false, failure: { code: "unavailable", retryable: true, status: res.status, message: `HTTP ${res.status}: response is not JSON` } };
    }
    const env = ErrorEnvelope.safeParse(json);
    if (!env.success) {
      return { ok: false, failure: { code: "unavailable", retryable: true, status: res.status, message: `HTTP ${res.status}: not an error envelope` } };
    }
    const after = env.data.error.retryable ? retryAfterMs(res.headers.get("retry-after"), now()) : undefined;
    return {
      ok: false,
      failure: {
        code: env.data.error.code,
        retryable: env.data.error.retryable,
        message: env.data.error.message,
        status: res.status,
        envelope: true,
        ...(after === undefined ? {} : { retryAfterMs: after }),
      },
    };
  }

  async function sendWithRetry<T>(url: string, init: RequestInit, parse: Parse<T>, deadlineMs: number, giveUpReason: string, uncertain?: string): Promise<T> {
    let attempts = 0;
    let backoff = RETRY_INITIAL_BACKOFF_MS;
    for (;;) {
      attempts++;
      const r = await attempt(url, init, parse, deadlineMs);
      if (r.ok) return r.value;
      const f = r.failure;
      if (uncertain !== undefined && f.envelope !== true) {
        throw new HorosError({
          code: "unavailable",
          message: `${f.message}: ${uncertain}`,
          retryable: false,
          ...(f.status === undefined ? {} : { status: f.status }),
          attempts,
        });
      }
      if (!f.retryable) throw failureError(f, attempts);
      // Retry-After is a floor: `Retry-After: 0` never turns the loop hot.
      const wait = Math.max(f.retryAfterMs ?? 0, backoff);
      backoff = Math.min(backoff * 2, RETRY_MAX_BACKOFF_MS);
      if (now() + wait >= deadlineMs) throw failureError(f, attempts, ` (gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${giveUpReason})`);
      await sleep(wait);
    }
  }

  return {
    now,
    sleep,
    attempt,
    sendWithRetry: (url, init, parse, deadlineMs, giveUpReason) => sendWithRetry(url, init, parse, deadlineMs, giveUpReason),
    sendRetryingEnvelopesOnly: (url, init, parse, deadlineMs, giveUpReason, uncertain) => sendWithRetry(url, init, parse, deadlineMs, giveUpReason, uncertain),
  };
}
