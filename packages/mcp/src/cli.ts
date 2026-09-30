#!/usr/bin/env node
// `horos-mcp`: the Horos MCP server over stdio, run in the Agent's runtime. Configuration comes from the environment
// (see config.ts). stdout is the MCP channel, so every log line goes to stderr. With HOROS_PAYMENT_PRIVATE_KEY the
// server signs Checks and ReadAccess with the Agent's Payment key; without it every Check is advisory.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHoros } from "@horos/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConfigError, configFromEnv } from "./config.js";
import { createHorosMcpServer } from "./server.js";

export interface CliIo {
  /** stderr only: stdout belongs to the MCP transport. */
  readonly err: (s: string) => void;
  readonly transport: () => Transport;
}

const defaultIo: CliIo = {
  err: (s) => process.stderr.write(`${s}\n`),
  transport: () => new StdioServerTransport(),
};

/** Start the server. Returns a non-zero exit code on a configuration error, 0 once connected. */
export async function main(env: Readonly<Record<string, string | undefined>>, io: CliIo = defaultIo): Promise<number> {
  let config: ReturnType<typeof configFromEnv>;
  let client: ReturnType<typeof createHoros>;
  try {
    config = configFromEnv(env);
    client = createHoros(config.options);
  } catch (err) {
    // ConfigError messages name the variable only; anything else is reported by name, never by message.
    io.err(`horos-mcp: ${err instanceof ConfigError ? err.message : `invalid configuration (${err instanceof Error ? err.name : "error"})`}`);
    return 1;
  }
  const server = createHorosMcpServer({ client });
  try {
    await server.connect(io.transport());
  } catch (err) {
    io.err(`horos-mcp: failed to start (${err instanceof Error ? err.name : "error"})`);
    return 1;
  }
  const o = config.options;
  const target = `api ${new URL(o.baseUrl).origin}, chain ${o.chainId}${o.policyWallet === undefined ? "" : `, PolicyWallet ${o.policyWallet}`}`;
  io.err(
    config.signerAddress === undefined
      ? `horos-mcp: advisory (no Payment key): Checks write nothing and are not enforcement; ${target}`
      : `horos-mcp: enforced (signed by ${config.signerAddress}); ${target}`,
  );
  return 0;
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const code = await main(process.env);
  if (code !== 0) process.exit(code);
}
