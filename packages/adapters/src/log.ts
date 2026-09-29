// Structured JSON logger shared by the api and worker entry points (AD-20, NFR: secrets never in logs).
// Every entry is redacted before it is written:
//   - a field whose key names a secret (the Circle credentials, tokens, private keys, connection strings) and any
//     `authorization` or `signature` field is replaced by "[redacted]", at any depth;
//   - every http(s) URL inside a string (webhook, RPC and SDN URLs; RPC paths can embed API keys) is reduced to its
//     origin, and a postgres connection string is replaced whole;
//   - an Error becomes `{name, message}` with the same string redaction (never its stack or cause chain).
import { redactUrls } from "@horos/schema";

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogEntry = Record<string, unknown>;

export interface Logger {
  debug(entry: LogEntry): void;
  info(entry: LogEntry): void;
  warn(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

export interface LoggerOptions {
  /** `api` or `worker`; written on every line. */
  readonly service: string;
  /** Entries below this level are dropped. Default `info`. */
  readonly level?: LogLevel;
  /** Line sink. Default: stdout. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

export const REDACTED = "[redacted]";

/**
 * Substrings of a normalised key (lowercase, alphanumerics only) that mark its value as secret: this catches
 * compound names such as `entitySecretCiphertext`, `accessToken`, `x-api-key` or `bearerToken`.
 */
const SECRET_KEY_PARTS = [
  "secret",
  "token",
  "apikey",
  "password",
  "privatekey",
  "authorization",
  "signature",
  "entitysecret",
  "credential",
  "cookie",
  "signerkeys",
  "databaseurl",
  "connectionstring",
];

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_PARTS.some((part) => k.includes(part));
}

const PG_URL = /postgres(?:ql)?:\/\/[^\s"'<>()]+/giu;
const CIRCLE_API_KEY = /\b(?:TEST|LIVE)_API_KEY:[^\s"',;]+/gu;
const BEARER = /\bBearer\s+[^\s"',;]+/giu;

/**
 * A string with every URL reduced to its origin, every postgres connection string removed, and Circle API keys and
 * bearer credentials replaced. Hex values (tx and record hashes are evidence) are left alone.
 */
export function redactString(s: string): string {
  return redactUrls(s.replace(PG_URL, "postgres://[redacted]"))
    .replace(CIRCLE_API_KEY, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`);
}

const MAX_DEPTH = 8;

/** A JSON-safe, redacted copy of `value` (bigints become decimal strings). */
export function redactLogValue(value: unknown, depth = 0, ancestors: Set<object> = new Set()): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "(invalid date)" : value.toISOString();
  if (depth >= MAX_DEPTH) return "[truncated]";
  // Only the current path counts as a cycle: an object shared by two siblings is printed twice, not "[circular]".
  if (ancestors.has(value)) return "[circular]";
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactLogValue(v, depth + 1, ancestors) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      const r = redactLogValue(v, depth + 1, ancestors);
      if (r !== undefined) out[k] = r;
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const min = LOG_LEVELS.indexOf(opts.level ?? "info");
  const write = opts.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());
  const emit = (level: LogLevel) => (entry: LogEntry) => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    const body = redactLogValue(entry) as Record<string, unknown>;
    // The envelope fields come first and always win over same-named entry fields.
    const envelope = { ts: now().toISOString(), level, service: opts.service };
    write(JSON.stringify({ ...envelope, ...body, ...envelope }));
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
