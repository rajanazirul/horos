// @horos/api: the HTTP API service.
export const PACKAGE_NAME = "@horos/api";

export { createApp, type AppDeps } from "./app.js";
export {
  clientIp,
  DEFAULT_CHECK_RATE_PER_MINUTE,
  postgresCheckDeps,
  registerCheckRoute,
  type CheckRouteDeps,
  type PostgresCheckDepsOptions,
} from "./check.js";
export { FixedWindowLimiter } from "./rate-limit.js";
export { firstMismatchedRole, registerOnboardingRoutes, type OnboardingDeps } from "./onboarding.js";
export { API_KEY_HEADER, registerReadRoutes, type ReadDeps } from "./reads.js";
export { registerShadowRoutes, type ShadowAccounts, type ShadowRouteDeps } from "./shadow.js";
export { uuidv7 } from "@horos/adapters";
