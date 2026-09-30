// @horos/mcp: the Horos MCP server over `@horos/sdk` (AD-17). `check` plus four read-only Decision Log tools; no
// tool Raises, Pins, sets a Limit, changes Policy, Registers or deploys, and the server holds no Horos or Human keys.
export {
  ADVISORY_NOTE,
  createHorosMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES,
  type HorosMcpServerOptions,
  type ToolName,
} from "./server.js";
export { ConfigError, configFromEnv, DEFAULT_CHAIN_ID, ENV, type McpConfig } from "./config.js";
