// `horos-quickstart deploy --human <address>`: deploy and bind the Agent's PolicyWallet through the SDK deploy helper,
// with the Payment key from the environment and ONLY the Policy Owner's (Human) address. Writes `horos.config.json`
// (public values only) and prints the deploy report: codehash, role holders, Policy, explorer links, funding steps.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deployPolicyWallet, HorosError, type DeployPolicyWalletOptions, type DeployResult } from "@horos/sdk";
import type { PrivateKeyAccount } from "viem";
import { publicClientFor, walletClientFor } from "./chain.js";
import { CONFIG_FILE, writeConfig } from "./config.js";
import { baseUrlFromEnv, chainIdFromEnv, parseHumanAddress, paymentAccountFromEnv, paymentKeySecret, QuickstartError, rpcUrlFromEnv, type Env } from "./env.js";

export interface DeployDeps {
  readonly root: string;
  readonly env: Env;
  readonly out: (line: string) => void;
  /** Default: the SDK's `deployPolicyWallet`. */
  readonly deployPolicyWallet?: (options: DeployPolicyWalletOptions) => Promise<DeployResult>;
  /** Default: viem clients on the configured chain. */
  readonly clients?: (chainId: number, rpcUrl: string | undefined, account: PrivateKeyAccount) => Pick<DeployPolicyWalletOptions, "publicClient"> & { walletClient: Extract<DeployPolicyWalletOptions["payment"], { kind: "eoa" }>["walletClient"] };
  readonly fetch?: DeployPolicyWalletOptions["fetch"];
  /** Deploy even when horos.config.json already names an enforced PolicyWallet. */
  readonly force?: boolean;
}

/** The enforced PolicyWallet already recorded in horos.config.json, if any (read loosely; no validation). */
function existingPolicyWallet(root: string): string | undefined {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as { mode?: unknown; policyWallet?: unknown };
    return c.mode === "enforced" && typeof c.policyWallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(c.policyWallet) ? c.policyWallet : undefined;
  } catch {
    return undefined;
  }
}

export async function deploy(humanRaw: string | undefined, deps: DeployDeps): Promise<DeployResult> {
  // The Human address is checked first: a key-shaped value is refused before anything else is read or run.
  const humanAddress = parseHumanAddress(humanRaw);
  if (deps.force !== true) {
    const existing = existingPolicyWallet(deps.root);
    if (existing !== undefined) {
      throw new QuickstartError(
        `${CONFIG_FILE} already names an enforced PolicyWallet (${existing}). Rerunning deploy would deploy a SECOND wallet. ` +
          "Keep using the existing one (run `horos-quickstart smoke`), or pass --force if you really want a new PolicyWallet.",
      );
    }
  }
  const account = paymentAccountFromEnv(deps.env);
  const baseUrl = baseUrlFromEnv(deps.env, true);
  const chainId = chainIdFromEnv(deps.env);
  const rpcUrl = rpcUrlFromEnv(deps.env, chainId);
  const clients = (deps.clients ?? ((id, rpc, acct) => ({ publicClient: publicClientFor(id, rpc), walletClient: walletClientFor(id, rpc, acct) })))(chainId, rpcUrl, account);
  const run = deps.deployPolicyWallet ?? deployPolicyWallet;
  const result = await run({
    baseUrl,
    chainId,
    humanAddress,
    payment: { kind: "eoa", account, walletClient: clients.walletClient },
    publicClient: clients.publicClient,
    log: deps.out,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  writeConfig(deps.root, { baseUrl, chainId, policyWallet: result.policyWallet, scope: result.scope, customerId: result.customerId, mode: "enforced" }, [paymentKeySecret(deps.env)]);
  deps.out(`\nWrote ${CONFIG_FILE} (public values only: api origin, chain, PolicyWallet, Scope, customer id, mode).`);
  return result;
}

/** A one-line, secret-free description of a deploy failure. */
export function describeFailure(err: unknown): string {
  if (err instanceof HorosError) return `${err.code}${err.retryable ? " (retryable: rerun the same command)" : ""}: ${err.message}`;
  return err instanceof Error ? err.name : "error";
}
