// Environment → SDK options for the `horos-mcp` stdio entry. The only key it can take is the Agent's Payment key
// (`HOROS_PAYMENT_PRIVATE_KEY`), turned into a viem local account; never a Human key, never a Horos-held key (AD-12).
// Errors name the variable and never echo its value.
import { Address, Scope, type Hex } from "@horos/schema";
import { fromViemAccount, type HorosOptions } from "@horos/sdk";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_CHAIN_ID = 5042002;

export const ENV = {
  baseUrl: "HOROS_BASE_URL",
  chainId: "HOROS_CHAIN_ID",
  policyWallet: "HOROS_POLICY_WALLET",
  scope: "HOROS_SCOPE",
  paymentKey: "HOROS_PAYMENT_PRIVATE_KEY",
} as const;

/** Hosts where a plain-http api is accepted with a Payment key (URL.hostname keeps IPv6 brackets). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {
  /** The environment variable at fault. */
  readonly variable: string;
  constructor(variable: string, problem: string) {
    super(`${variable} ${problem}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

export interface McpConfig {
  /** Options for `createHoros`. Carries a signer only when a Payment key was given. */
  readonly options: HorosOptions;
  /** The Payment key's address, when there is one. */
  readonly signerAddress?: Hex;
}

/** An env value, with empty or whitespace-only treated as unset. */
function read(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Parse and validate the environment. Throws `ConfigError` (message names the variable only). */
export function configFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): McpConfig {
  const baseUrl = read(env, ENV.baseUrl);
  if (baseUrl === undefined) throw new ConfigError(ENV.baseUrl, "is required (the Horos api origin, e.g. https://api.example.com)");
  let url: URL | undefined;
  try {
    url = new URL(baseUrl);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) throw new ConfigError(ENV.baseUrl, "must be an absolute http(s) URL");

  let chainId = DEFAULT_CHAIN_ID;
  const chainRaw = read(env, ENV.chainId);
  if (chainRaw !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/.test(chainRaw) || !Number.isSafeInteger(Number(chainRaw))) throw new ConfigError(ENV.chainId, "must be a positive integer");
    chainId = Number(chainRaw);
  }

  let policyWallet: Hex | undefined;
  const walletRaw = read(env, ENV.policyWallet);
  if (walletRaw !== undefined) {
    const w = Address.safeParse(walletRaw);
    if (!w.success) throw new ConfigError(ENV.policyWallet, "must be a 0x address with 40 hex digits");
    policyWallet = w.data;
  }

  let scope: string | undefined;
  const scopeRaw = read(env, ENV.scope);
  if (scopeRaw !== undefined) {
    const s = Scope.safeParse(scopeRaw);
    if (!s.success) throw new ConfigError(ENV.scope, "must be a Scope id (enforced:<uuid>, shadow:<uuid> or advisory-public)");
    scope = s.data;
  }

  const keyRaw = read(env, ENV.paymentKey);
  if (keyRaw === undefined) {
    return {
      options: { baseUrl, chainId, ...(policyWallet === undefined ? {} : { policyWallet }), ...(scope === undefined ? {} : { scope }) },
    };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyRaw)) throw new ConfigError(ENV.paymentKey, "must be a 0x-prefixed 32-byte hex private key (the Agent's Payment key)");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(keyRaw as Hex);
  } catch {
    // Never the underlying message: it could quote the key.
    throw new ConfigError(ENV.paymentKey, "is not a valid secp256k1 private key");
  }
  // Signed Checks and ReadAccess must not cross the network in cleartext: https unless the api is on this machine.
  if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError(ENV.baseUrl, `must use https when ${ENV.paymentKey} is set (plain http is allowed only for localhost, 127.0.0.1 or ::1)`);
  }
  if (policyWallet === undefined) throw new ConfigError(ENV.policyWallet, `is required when ${ENV.paymentKey} is set (signed Checks are bound to your PolicyWallet)`);
  return {
    options: { baseUrl, chainId, policyWallet, signer: fromViemAccount(account), ...(scope === undefined ? {} : { scope }) },
    signerAddress: account.address.toLowerCase() as Hex,
  };
}
