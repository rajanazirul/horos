// @horos/skill: the `horos-quickstart` CLI behind the Horos Claude Code plugin (skill `horos-quickstart`, in plugin/).
// It imports only @horos/sdk, @horos/schema and viem (Payment-key account, pay simulation, a random address, and the
// clients the SDK deploy helper needs). No Circle SDK, no @horos/owner (AD-12, AD-22).
export { main, parseArgs, USAGE, type CliDeps } from "./cli.js";
export { assertNoOwner, CONFIG_FILE, ownerDependencyFields, ownerInstalled, readConfig, SecretInFileError, writePublicFile, type HorosConfig, type Mode } from "./config.js";
export { deploy, type DeployDeps } from "./deploy.js";
export { ConfigError, DEFAULT_CHAIN_ID, ENV, HUMAN_KEY_REFUSED, NO_PAYMENT_KEY, parseHumanAddress, QuickstartError, withDotEnv } from "./env.js";
export { formatPreflight, gitTrackedFiles, isGitignored, MIN_NODE, preflight, type PreflightCheck, type PreflightResult } from "./preflight.js";
export { DEFAULT_KEY_FILE, resolveKeyFile, shadow, SHADOW_CLOSED_ADVICE, type ShadowDeps } from "./shadow.js";
export { BLOCKING_REVERTS, demoAddress, loadDemoList, parseUsdc, revertOf, smoke, type DemoList, type SmokeDeps, type SmokeOptions } from "./smoke.js";
export { formatElapsed, QUICKSTART_FILE, readQuickstart, TEN_MINUTES_SECONDS, type Quickstart, type SmokeRun } from "./timing.js";
