// The api's environment (AD-15, AD-20), validated at boot. The api is internet-facing, so it holds only its own
// app-role login: it refuses to boot when a Circle secret, the migrator URL or local signer keys are present, so a
// misconfigured service cannot hold them (least privilege; those belong to the worker).
import { forbidden, intFromString, parseEnv, sharedEnvShape, type EnvResult, type RawEnv } from "@horos/adapters";
import { Scope } from "@horos/schema";
import { z } from "zod";

const CIRCLE_SECRET_IN_API = "must not be set for the api (the Circle secrets are worker-only)";
const WORKER_ONLY = "must not be set for the api (worker-only)";

export const ApiEnvSchema = z.object({
  ...sharedEnvShape,
  PORT: intFromString(1, 65_535).default(8080),
  ADMIN_TOKEN: z.string().min(32, "must be at least 32 characters"),
  PUBLIC_DEMO_SCOPE: Scope.optional(),
  /** Railway's edge proxy appends one `x-forwarded-for` hop. */
  TRUSTED_PROXY_HOPS: intFromString(0, 10).default(1),
  CHECK_RATE_PER_MINUTE: intFromString(1, 100_000).optional(),
  /** How long the Check path caches a wallet's on-chain Policy and role holders; 0 disables. */
  CHAIN_READ_CACHE_MS: intFromString(0, 60_000).default(5_000),
  CIRCLE_API_KEY: forbidden(CIRCLE_SECRET_IN_API),
  CIRCLE_ENTITY_SECRET: forbidden(CIRCLE_SECRET_IN_API),
  MIGRATOR_DATABASE_URL: forbidden(WORKER_ONLY),
  LOCAL_SIGNER_KEYS: forbidden(WORKER_ONLY),
});

export type ApiEnv = z.output<typeof ApiEnvSchema>;

export function parseApiEnv(raw: RawEnv): EnvResult<ApiEnv> {
  return parseEnv(ApiEnvSchema, raw);
}
