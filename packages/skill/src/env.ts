// Environment → quickstart inputs, in the same style as the MCP server's config: errors name the variable and never
// echo its value. The only keys read are the Agent's Payment key (`HOROS_PAYMENT_PRIVATE_KEY`) and, in Shadow Mode,
// the API key (`HOROS_API_KEY`). A Human (Policy Owner) key is never read, asked for or accepted (AD-12): the Human
// is an address passed as `--human`.
//
// viem is used here only to turn the env Payment key into an account and to generate a throwaway random address.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Address, type Hex } from "@horos/schema";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress, type PrivateKeyAccount } from "viem/accounts";

export const DEFAULT_CHAIN_ID = 5042002;

export const ENV = {
  baseUrl: "HOROS_BASE_URL",
  chainId: "HOROS_CHAIN_ID",
  rpcUrl: "HOROS_RPC_URL",
  paymentKey: "HOROS_PAYMENT_PRIVATE_KEY",
  apiKey: "HOROS_API_KEY",
} as const;

export type Env = Readonly<Record<string, string | undefined>>;

/** Hosts where a plain-http api is accepted with a key (URL.hostname keeps IPv6 brackets). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A problem the developer must fix. The message never contains a secret. */
export class QuickstartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuickstartError";
  }
}

/** A bad or missing environment variable; the message names the variable only. */
export class ConfigError extends QuickstartError {
  readonly variable: string;
  constructor(variable: string, problem: string) {
    super(`${variable} ${problem}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

/** What to do when there is no Payment key in the environment (the Circle path stays in the developer's own code). */
export const NO_PAYMENT_KEY =
  `${ENV.paymentKey} is not set. Put the Agent's Payment key (0x + 64 hex) in your shell environment or a gitignored ` +
  ".env file, then rerun. Using a Circle developer-controlled wallet as the Payment key instead? This CLI does not " +
  "import Circle SDKs: run the deploy from your own code with circleDcwSigner + deployPolicyWallet (see SKILL.md, " +
  '"Circle Payment path").';

/** An env value, with empty or whitespace-only treated as unset. */
export function read(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** `HOROS_BASE_URL` as an absolute http(s) origin. With `keyed`, plain http is refused unless the api is on this machine. */
export function baseUrlFromEnv(env: Env, keyed: boolean): string {
  const raw = read(env, ENV.baseUrl);
  if (raw === undefined) throw new ConfigError(ENV.baseUrl, "is required (the Horos api origin, e.g. https://api.example.com)");
  return checkBaseUrl(raw, keyed, ENV.baseUrl);
}

/** Validate an api origin (from the environment or horos.config.json). */
export function checkBaseUrl(raw: string, keyed: boolean, where: string): string {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) throw new ConfigError(where, "must be an absolute http(s) URL");
  // The SDK talks to `<origin>/v1/...`: a path prefix would be dropped silently, so refuse it.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new ConfigError(where, "must be the api origin only (scheme, host and port; no path, query or credentials)");
  }
  if (keyed && url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError(where, "must use https when a key is used (plain http is allowed only for localhost, 127.0.0.1 or ::1)");
  }
  return url.origin;
}

export function chainIdFromEnv(env: Env): number {
  const raw = read(env, ENV.chainId);
  if (raw === undefined) return DEFAULT_CHAIN_ID;
  if (!/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ConfigError(ENV.chainId, "must be a positive integer");
  return Number(raw);
}

/** `HOROS_RPC_URL`, if set. Required off Arc testnet. Never printed (RPC URLs can carry an API key). */
export function rpcUrlFromEnv(env: Env, chainId: number): string | undefined {
  const raw = read(env, ENV.rpcUrl);
  if (raw === undefined) {
    if (chainId !== DEFAULT_CHAIN_ID) throw new ConfigError(ENV.rpcUrl, `is required when the chain is not Arc testnet (${DEFAULT_CHAIN_ID})`);
    return undefined;
  }
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url === undefined || !/^(?:https?|wss?):$/.test(url.protocol)) throw new ConfigError(ENV.rpcUrl, "must be an absolute http(s) or ws(s) URL");
  return raw;
}

/** The Agent's Payment key from the environment, as a viem account. Throws with `NO_PAYMENT_KEY` when unset. */
export function paymentAccountFromEnv(env: Env): PrivateKeyAccount {
  const raw = read(env, ENV.paymentKey);
  if (raw === undefined) throw new QuickstartError(NO_PAYMENT_KEY);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new ConfigError(ENV.paymentKey, "must be a 0x-prefixed 32-byte hex private key (the Agent's Payment key)");
  try {
    return privateKeyToAccount(raw as Hex);
  } catch {
    // Never the underlying message: it could quote the key.
    throw new ConfigError(ENV.paymentKey, "is not a valid secp256k1 private key");
  }
}

/** The raw Payment key, when set (only to keep it out of every file the CLI writes). */
export function paymentKeySecret(env: Env): string | undefined {
  return read(env, ENV.paymentKey);
}

/** The Shadow Mode API key from the environment. */
export function apiKeyFromEnv(env: Env): string {
  const raw = read(env, ENV.apiKey);
  if (raw === undefined) throw new ConfigError(ENV.apiKey, 'is not set: load the key `horos-quickstart shadow` saved, e.g. export HOROS_API_KEY="$(cat ~/.config/horos/shadow-api-key)" (never put it in the repo)');
  if (!/^hsk_[A-Za-z0-9_-]{16,}$/.test(raw)) throw new ConfigError(ENV.apiKey, "must be the hsk_… key from `horos-quickstart shadow`");
  return raw;
}

const PRIVATE_KEY_SHAPE = /^(?:0x)?[0-9a-f]{64}$/i;
const HEX_RUN_64 = /[0-9a-f]{64}/i;

export const HUMAN_KEY_REFUSED =
  "refused: --human looks like a private key (32 bytes of hex). Pass only the Policy Owner's (Human) ADDRESS (0x + 40 hex). " +
  "The Human key must stay in its own custody domain (for example a hardware wallet) that the agent's runtime, this repo, " +
  "its environment and this CLI can never reach; Horos never needs it. The value was not used, stored or printed. If that " +
  "was a real key, treat it as exposed (it may be in your shell history) and move the Policy Owner to a fresh wallet.";

/**
 * Parse `--human`: an address only. A private-key-shaped or seed-phrase-shaped value is refused (and never echoed);
 * any other invalid value is refused without echo too.
 */
export function parseHumanAddress(raw: string | undefined): Hex {
  if (raw === undefined || raw.trim() === "") throw new QuickstartError("--human <address> is required: the Policy Owner's (Human) address. Only the address; never the key.");
  const v = raw.trim();
  // Key-shaped in any disguise (0X prefix, quotes, trailing punctuation, spaces): 64 hex digits once everything that is
  // not hex or an x is stripped.
  if (PRIVATE_KEY_SHAPE.test(v) || HEX_RUN_64.test(v.replace(/[^0-9a-fA-FxX]/g, ""))) throw new QuickstartError(HUMAN_KEY_REFUSED);
  if (/\s/.test(v)) throw new QuickstartError("refused: --human looks like a phrase, not an address. Pass only the Policy Owner's address (0x + 40 hex); never a seed phrase or key. The value was not used or printed.");
  const parsed = Address.safeParse(v);
  if (!parsed.success) throw new QuickstartError("--human must be a 0x address with 40 hex digits (the Policy Owner's address). The value was not printed.");
  return parsed.data;
}

/** A fresh random address for the known-good smoke Check. The key is generated and dropped at once: never funded, never kept. */
export function randomAddress(): Hex {
  return privateKeyToAddress(generatePrivateKey()).toLowerCase() as Hex;
}

/**
 * `<root>/.env`, when present, under the process environment: variables already set win. Nothing is printed. (The
 * same parser as `process.loadEnvFile`, Node >= 20.12, without mutating `process.env`.)
 */
export function withDotEnv(root: string, env: Env): Env {
  const path = join(root, ".env");
  if (!existsSync(path)) return env;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    throw new QuickstartError(".env could not be read (its contents were not printed)");
  }
  const merged: Record<string, string | undefined> = { ...parsed };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v;
  return merged;
}
