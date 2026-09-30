// `horos-quickstart shadow`: sign up for Shadow Mode with the Payment key from the environment. The api returns an API
// key once. It is written to a 0600 file OUTSIDE the repo (default ~/.config/horos/shadow-api-key, or --key-file) and
// never printed, so it stays out of the terminal, Claude's context and the transcript; only the path and an export line
// that reads the file are printed. `horos.config.json` gets
// `mode: "shadow"` and the shadow Scope. Shadow Checks are advisory: nothing goes on-chain and the agent's payment
// path stays as it is.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fromViemAccount, HorosError, shadowSignup, type ShadowSignupOptions, type ShadowSignupResult } from "@horos/sdk";
import { CONFIG_FILE, writeConfig } from "./config.js";
import { baseUrlFromEnv, chainIdFromEnv, ENV, paymentAccountFromEnv, paymentKeySecret, QuickstartError, type Env } from "./env.js";

export interface ShadowDeps {
  readonly root: string;
  readonly env: Env;
  readonly out: (line: string) => void;
  /** Default: the SDK's `shadowSignup`. */
  readonly shadowSignup?: (options: ShadowSignupOptions) => Promise<ShadowSignupResult>;
  readonly fetch?: ShadowSignupOptions["fetch"];
  /** The user's home directory (for the default key file). */
  readonly home: string;
  /** Where to write the API key (`--key-file`); must be outside the repo. Relative paths resolve against `root`. */
  readonly keyFile?: string;
}

export const DEFAULT_KEY_FILE = [".config", "horos", "shadow-api-key"] as const;

/** Resolve the key file and refuse any path inside the repo (compared by real path, so symlinks do not help). */
export function resolveKeyFile(root: string, home: string, keyFile: string | undefined): string {
  const path = keyFile === undefined ? join(home, ...DEFAULT_KEY_FILE) : resolve(root, keyFile);
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, path));
  const rel = relative(realpathSync(resolve(root)), real);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new QuickstartError("refused: --key-file is inside the agent repo. The Shadow API key must live outside the repo (default ~/.config/horos/shadow-api-key).");
  }
  return path;
}

/** Write the key to a file only the user can read (0600, directory 0700). */
function writeKeyFile(path: string, apiKey: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export const SHADOW_CLOSED_ADVICE =
  "Shadow Mode is closed for this Customer: its PolicyWallet is already bound. Use the enforced path instead " +
  "(`horos-quickstart smoke` against the existing horos.config.json, or `horos-quickstart deploy --human <address>`).";

export async function shadow(deps: ShadowDeps): Promise<ShadowSignupResult> {
  const account = paymentAccountFromEnv(deps.env);
  const baseUrl = baseUrlFromEnv(deps.env, true);
  const chainId = chainIdFromEnv(deps.env);
  const keyPath = resolveKeyFile(deps.root, deps.home, deps.keyFile);
  const signup = deps.shadowSignup ?? shadowSignup;
  let res: ShadowSignupResult;
  try {
    res = await signup({ baseUrl, chainId, signer: fromViemAccount(account), ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  } catch (err) {
    if (err instanceof HorosError && err.code === "shadow_closed") throw new QuickstartError(SHADOW_CLOSED_ADVICE);
    throw err;
  }
  writeKeyFile(keyPath, res.apiKey);
  writeConfig(deps.root, { baseUrl, chainId, policyWallet: null, scope: res.scope, customerId: res.customerId, mode: "shadow" }, [paymentKeySecret(deps.env), res.apiKey]);
  const quoted = `'${keyPath.replace(/'/g, `'\\''`)}'`;
  deps.out(
    [
      `Shadow Mode is on for Customer ${res.customerId} (Scope ${res.scope}).`,
      `Wrote ${CONFIG_FILE} (mode "shadow"; no key in it).`,
      "",
      `Your Shadow API key is in ${keyPath} (readable only by you, outside the repo). It is not printed. Load it with:`,
      "",
      `  export ${ENV.apiKey}="$(cat ${quoted})"`,
      "",
      "Never paste the key into a chat, the repo or a log. A later `horos-quickstart shadow` issues a new key, revokes this one and overwrites the file.",
      "Shadow Checks are advisory: nothing is written on-chain and your payment path is unchanged.",
    ].join("\n"),
  );
  return res;
}
