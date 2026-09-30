#!/usr/bin/env node
// `horos-quickstart`: the deterministic half of the Horos Claude Code skill. Run it from the agent repo's root.
//   preflight                         Node, package.json, no @horos/owner, .env* gitignored
//   start                             start the ten-minute timer (.horos/quickstart.json)
//   deploy --human <address> [--force] deploy + bind the PolicyWallet (Payment key from env; Human ADDRESS only)
//   shadow [--key-file <path>]        Shadow Mode sign-up; the API key goes to a 0600 file outside the repo
//   smoke [--shadow] [--good <address>] [--amount <usdc>]
//                                     smoke test; records pass/fail and the elapsed time
// It never edits the agent's source, never writes a key to a file, never reads or accepts a Human key, and refuses to
// run when @horos/owner is in the repo's package.json.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertNoOwner } from "./config.js";
import { deploy, describeFailure, type DeployDeps } from "./deploy.js";
import { ENV, parseHumanAddress, QuickstartError, read, withDotEnv, type Env } from "./env.js";
import { formatPreflight, preflight } from "./preflight.js";
import { shadow, type ShadowDeps } from "./shadow.js";
import { smoke, type SmokeDeps } from "./smoke.js";
import { markStep, startTimer } from "./timing.js";

export const USAGE = `usage: horos-quickstart <command> [options]   (run from the agent repo's root)

  preflight                        check Node, package.json, no @horos/owner, .env* gitignored
  start                            start the ten-minute timer
  deploy --human <address> [--force]
                                   deploy and bind your PolicyWallet (Human ADDRESS only, never a key); refuses
                                   when horos.config.json already has one, unless --force
  shadow [--key-file <path>]       Shadow Mode: API key written to a 0600 file outside the repo
                                   (default ~/.config/horos/shadow-api-key), never printed
  smoke [--shadow] [--good <address>] [--amount <usdc>]
                                   smoke test; records the result and elapsed time

Environment: HOROS_BASE_URL, HOROS_PAYMENT_PRIVATE_KEY (the Agent's Payment key), HOROS_CHAIN_ID (default 5042002),
HOROS_RPC_URL (optional on Arc testnet), HOROS_API_KEY (Shadow smoke). A .env file in the repo root is loaded
without overriding variables already set.`;

export interface CliDeps {
  readonly root: string;
  readonly env: Env;
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly now: () => number;
  readonly nodeVersion: string;
  /** The user's home directory (default location of the Shadow API key file). */
  readonly home: string;
  readonly deploy?: Partial<Pick<DeployDeps, "deployPolicyWallet" | "clients" | "fetch">>;
  readonly shadow?: Partial<Pick<ShadowDeps, "shadowSignup" | "fetch">>;
  readonly smoke?: Partial<Pick<SmokeDeps, "createHoros" | "fetch" | "publicClient" | "demoList" | "randomAddress">>;
}

interface Parsed {
  readonly command: string | undefined;
  readonly flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["--human", "--good", "--amount", "--key-file"]);
const BOOL_FLAGS = new Set(["--shadow", "--force", "--help", "-h"]);

/**
 * A flag name safe to echo: a short, letters-and-dashes name that is not hex-only. Anything else (a pasted key, an
 * address, a long token) is never printed.
 */
function echoable(name: string): string {
  const bare = name.replace(/^-+/, "");
  return /^-{1,2}[a-z][a-z-]{0,23}$/i.test(name) && !/^[0-9a-f]+$/i.test(bare) ? name : "(value not printed)";
}

/** Parse argv. Unknown flags are errors; flag values, and flag names that could be secrets, are never echoed. */
export function parseArgs(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (VALUE_FLAGS.has(name)) {
        let value: string | undefined;
        if (eq === -1) {
          const next = argv[i + 1];
          // A following flag is not a value: `--human --shadow` means --human is missing its value.
          if (next !== undefined && !next.startsWith("-")) {
            value = next;
            i++;
          }
        } else {
          value = a.slice(eq + 1);
        }
        if (value === undefined || value === "") throw new QuickstartError(`${name} needs a value`);
        flags.set(name, value);
      } else if (BOOL_FLAGS.has(name) && eq === -1) {
        flags.set(name, true);
      } else {
        throw new QuickstartError(`unknown option ${echoable(name)}`);
      }
    } else if (command === undefined) {
      command = a;
    } else {
      throw new QuickstartError("too many arguments (the value was not printed)");
    }
  }
  return { command, flags };
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Run one command; returns the process exit code. Errors are printed without secrets. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    deps.err(`horos-quickstart: ${err instanceof QuickstartError ? err.message : "invalid arguments"}\n\n${USAGE}`);
    return 2;
  }
  const { command, flags } = parsed;
  if (command === undefined || flags.has("--help") || flags.has("-h") || command === "help") {
    deps.out(USAGE);
    return command === undefined && !flags.has("--help") && !flags.has("-h") ? 2 : 0;
  }
  const allowed: Readonly<Record<string, readonly string[]>> = {
    preflight: [],
    start: [],
    deploy: ["--human", "--force"],
    shadow: ["--key-file"],
    smoke: ["--shadow", "--good", "--amount"],
  };
  const ok = allowed[command];
  if (ok === undefined) {
    deps.err(`horos-quickstart: unknown command\n\n${USAGE}`);
    return 2;
  }
  for (const f of flags.keys()) {
    if (!ok.includes(f)) {
      deps.err(`horos-quickstart: ${command} does not take ${f}`);
      return 2;
    }
  }

  /** A timer write that fails after the real work succeeded is a warning, not a failure (a rerun could redo the work). */
  const mark = (step: string, env: Env) => {
    try {
      markStep(deps.root, step, deps.now(), [read(env, ENV.paymentKey), read(env, ENV.apiKey)], deps.err);
    } catch (err) {
      deps.err(`warning: ${step} succeeded, but .horos/quickstart.json could not be updated (${err instanceof QuickstartError ? err.message : err instanceof Error ? err.name : "error"}). Do not rerun ${step}.`);
    }
  };

  try {
    // `<root>/.env`, when present, fills in variables the shell has not set.
    const env = withDotEnv(deps.root, deps.env);
    switch (command) {
      case "preflight": {
        const r = preflight({ root: deps.root, env, nodeVersion: deps.nodeVersion });
        (r.ok ? deps.out : deps.err)(formatPreflight(r));
        return r.ok ? 0 : 1;
      }
      case "start": {
        assertNoOwner(deps.root);
        const q = startTimer(deps.root, deps.now(), deps.err);
        deps.out(`timer started at ${q.startedAt ?? "?"} (.horos/quickstart.json). Target: first passing smoke test within 10 minutes.`);
        return 0;
      }
      case "deploy": {
        // --human first: a key-shaped value is refused (never echoed) before anything else is read or run.
        parseHumanAddress(str(flags.get("--human")));
        assertNoOwner(deps.root);
        await deploy(str(flags.get("--human")), { root: deps.root, env, out: deps.out, force: flags.has("--force"), ...deps.deploy });
        mark("deploy", env);
        return 0;
      }
      case "shadow": {
        assertNoOwner(deps.root);
        const keyFile = str(flags.get("--key-file"));
        await shadow({ root: deps.root, env, out: deps.out, home: deps.home, ...(keyFile === undefined ? {} : { keyFile }), ...deps.shadow });
        mark("shadow", env);
        return 0;
      }
      case "smoke": {
        assertNoOwner(deps.root);
        const good = str(flags.get("--good"));
        const amount = str(flags.get("--amount"));
        const { run, persistError } = await smoke(
          { shadow: flags.has("--shadow"), ...(good === undefined ? {} : { good }), ...(amount === undefined ? {} : { amount }) },
          { root: deps.root, env, out: deps.out, err: deps.err, now: deps.now, ...deps.smoke },
        );
        return run.passed && persistError === null ? 0 : 1;
      }
    }
  } catch (err) {
    deps.err(`horos-quickstart ${command}: ${err instanceof QuickstartError ? err.message : describeFailure(err)}`);
    return 1;
  }
  return 2;
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
  const code = await main(process.argv.slice(2), {
    root: process.cwd(),
    env: process.env,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    now: Date.now,
    nodeVersion: process.versions.node,
    home: homedir(),
  });
  process.exit(code);
}
