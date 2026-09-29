// Boot-time environment validation shared by the api, worker and migrate entry points (AD-20). Each service
// declares a zod schema; `parseEnv` treats empty strings as unset and, on failure, reports only the names of
// the invalid variables and a value-free problem label: never a value, which may be a secret.
import { z } from "zod";

export type RawEnv = Readonly<Record<string, string | undefined>>;

export interface EnvProblem {
  readonly name: string;
  readonly problem: string;
}

export type EnvResult<T> = { readonly ok: true; readonly env: T } | { readonly ok: false; readonly invalid: readonly EnvProblem[] };

const httpUrl = () => z.url({ protocol: /^https?$/, message: "must be an http(s) URL" });

/** A postgres connection string. */
export const postgresUrl = () => z.url({ protocol: /^postgres(?:ql)?$/, message: "must be a postgres:// URL" });

/** A whole number, from its decimal string. */
export const intFromString = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^[0-9]+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min, `must be >= ${min}`).max(max, `must be <= ${max}`));

/** Variables both services read. `JEV_API_KEY` is accepted and unused until Epic 4. */
export const sharedEnvShape = {
  DATABASE_URL: postgresUrl(),
  CHAIN_ID: intFromString(1),
  ARC_RPC_PRIMARY: httpUrl(),
  ARC_RPC_SECONDARY: httpUrl(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"], { message: "must be one of debug, info, warn, error" }).optional(),
  JEV_API_KEY: z.string().optional(),
};

export { httpUrl };

/** Refuses the variable whenever it is set (e.g. the Circle secrets in the api). */
export const forbidden = (why: string) =>
  z
    .string()
    .refine(() => false, why)
    .optional();

/** Value-free label for a zod issue: custom messages are ours (never interpolate values); built-ins map by code. */
function problemOf(issue: z.core.$ZodIssue): string {
  // Every raw value is a string, so a type mismatch can only mean the variable is missing.
  if (issue.code === "invalid_type") return "required";
  if (issue.code === "custom" || issue.code === "invalid_format" || issue.code === "too_small" || issue.code === "too_big" || issue.code === "invalid_value") {
    return issue.message;
  }
  return issue.code;
}

/** Parse `raw` (typically `process.env`) with `schema`; empty strings count as unset. */
export function parseEnv<S extends z.ZodType>(schema: S, raw: RawEnv): EnvResult<z.output<S>> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== "") cleaned[k] = v;
  const r = schema.safeParse(cleaned);
  if (r.success) return { ok: true, env: r.data };
  const seen = new Set<string>();
  const invalid: EnvProblem[] = [];
  for (const issue of r.error.issues) {
    const name = issue.path.length > 0 ? String(issue.path[0]) : "(environment)";
    if (seen.has(name)) continue;
    seen.add(name);
    invalid.push({ name, problem: problemOf(issue) });
  }
  return { ok: false, invalid };
}

/** One line naming every invalid variable, for stderr. Contains no values. */
export function describeEnvFailure(service: string, invalid: readonly EnvProblem[]): string {
  return `${service}: invalid environment: ${invalid.map((p) => `${p.name} (${p.problem})`).join(", ")}`;
}
