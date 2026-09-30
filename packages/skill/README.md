# @horos/skill

The Horos Claude Code plugin and its helper CLI, `horos-quickstart`. Together they wire Horos into an existing agent
that pays in USDC: one `check()` before the agent's transfer, and the transfer routed through the agent's own
PolicyWallet (`PolicyWallet.pay`). Teams that are not ready to move funds can start in Shadow Mode instead, where
Checks are advisory and the payment path stays unchanged. The target is under ten minutes from a clean agent repo to
a passing smoke test (SM-4).

Horos is a policy-enforcement and evidence tool. It does not make you compliant: you remain the compliance
decision-maker.

- `plugin/`: the Claude Code plugin `horos`, with one skill, `horos-quickstart`
  (`plugin/skills/horos-quickstart/SKILL.md`). The skill drives the integration: it runs the CLI and tells Claude how to
  find the agent's USDC transfer and insert the Horos code, showing the diff before writing it.
- `src/`: the `horos-quickstart` CLI. It does every step that needs no judgement. It never edits the agent's source.

The package is workspace-only for now (`private`, not yet on npm). Build it with `pnpm --filter @horos/skill... build`
and run `node <horos-checkout>/packages/skill/dist/cli.js` from the agent repo. After publication:
`npx --package @horos/skill horos-quickstart`.

## Install the plugin

From Claude Code, add this repository as a plugin marketplace, then install the plugin:

```sh
claude plugin marketplace add TODO(founder)/horos     # the public GitHub repo path, or a local path to this repository
claude plugin install horos@horos
```

The marketplace file is `.claude-plugin/marketplace.json` at the repo root. It lists the plugin at
`./packages/skill/plugin`. Then, in the agent repo, ask Claude to "add Horos" (or run the `horos-quickstart` skill).

## CLI commands

Run from the agent repo's root.

| Command | What it does |
|---------|--------------|
| `start` | Starts the timer (run it first): resets `.horos/quickstart.json` with the start time, keeping the saved known-good smoke address. |
| `preflight` | Checks Node >= 20.12, a `package.json`, that `@horos/owner` is in no dependency field (including `npm:` aliases and `pnpm.overrides`) and not installed in `node_modules`, and that every `.env*` file in the tree is gitignored and not tracked by git. Writes nothing. Exit 0 when every required check passes. |
| `deploy --human <address> [--force]` | Enforced mode. Runs the SDK deploy helper (`deployPolicyWallet`, EOA path) with the Payment key from the environment and the Policy Owner's (Human) **address**, then writes `horos.config.json` and prints the deploy report (codehash, role holders, Policy, explorer links, funding steps). Refuses when `horos.config.json` already names an enforced PolicyWallet (a rerun would deploy a second one) unless `--force`. |
| `shadow [--key-file <path>]` | Shadow Mode. Signs up with the Payment key and writes the API key to a 0600 file **outside the repo** (default `~/.config/horos/shadow-api-key`; an in-repo path is refused). The key is never printed; only the path and `export HOROS_API_KEY="$(cat <path>)"`. Writes `horos.config.json` with `mode: "shadow"`. On `shadow_closed` it tells you to use enforced mode. Each run issues a new key and revokes the old one. |
| `smoke [--good <address>] [--amount <usdc>]` | Enforced smoke test (see below). |
| `smoke --shadow` | Shadow smoke test: the same two Checks, advisory, with each `outcome` recorded. No pay simulation. |

Environment:

| Variable | |
|----------|---|
| `HOROS_BASE_URL` | The Horos api origin only (no path). Must be `https` (plain `http` only for localhost). `smoke` uses `horos.config.json` and warns if this differs. |
| `HOROS_PAYMENT_PRIVATE_KEY` | The Agent's **Payment** key (0x + 64 hex). Needed by `deploy`, `shadow` and the enforced `smoke`. |
| `HOROS_CHAIN_ID` | Default `5042002` (Arc testnet). |
| `HOROS_RPC_URL` | Optional on Arc testnet (viem's default Arc RPC otherwise); required on any other chain. Never printed. |
| `HOROS_API_KEY` | The Shadow Mode key, for `smoke --shadow`. |

A `.env` file in the agent repo's root is loaded (Node's `.env` parser), without overriding variables already set.

On the Circle Payment path (a Circle developer-controlled wallet as the Payment key), deploy from your own code with
`circleDcwSigner` + `deployPolicyWallet`. This package does not import Circle SDKs (AD-22). SKILL.md shows the
snippet.

## Key rules the CLI enforces

- Keys come only from the environment. Every file the CLI writes goes through one helper that refuses content matching
  a private-key pattern (32 bytes of hex), an `hsk_` API key, or the env key's value. The files hold public values only.
- `--human` must be an address. A 32-byte hex value (or a phrase) is refused with the custody explanation, and the
  value is never echoed. The CLI never asks for, reads or accepts a Human key.
- Every command except `preflight` refuses to run while `@horos/owner` is declared in the agent repo's `package.json` or
  installed in its `node_modules`; `preflight` reports it as a failed check. The CLI never installs it.
- Writes follow real paths: a symlinked `.horos` or config file pointing out of the repo is refused.
- No USDC moves. The enforced smoke test's known-good Check is enforced, so Horos queues one first-contact Limit write
  for that address (one new-payee slot on the PolicyWallet); the generated address is saved and reused on reruns. The
  `pay` step is a simulation only (`simulateContract`, no transaction).

## Files written in the agent repo

- `horos.config.json`: `baseUrl`, `chainId`, `policyWallet` (null in Shadow Mode), `scope`, `customerId`, `mode`.
- `.horos/quickstart.json`: the start time, step timestamps, the latest smoke run, `passed`, `failedStep`,
  `firstPassedAt`, `elapsedSeconds`, `underTenMinutes`, and the reusable known-good smoke address.

`horos.config.json` holds public values only and may be committed. `.horos/` is local run state and may be gitignored.
The Shadow API key is never in the repo.

## Smoke test and SM-4 timing

The enforced `smoke` runs three steps and stops at the first failure:

1. A signed Check on a known-good address for `--amount` USDC (default 1). Expects `allow`, not advisory. The address is
   `--good`, or a random address generated on the first run (never funded, its key dropped at once), saved in
   `.horos/quickstart.json` and reused on reruns, so reruns do not spend more new-payee slots. This Check queues one
   first-contact Limit write on the PolicyWallet. `--good` may not be any Horos Demo List address.
2. A Check on the first address of the Horos Demo List (a labelled, fictional test list, bundled into `dist/` at
   build). Expects `block` with `simulated: true`.
3. A forced `PolicyWallet.pay` to that Demo List address, simulated only. The RPC must be on `chainId` and the
   PolicyWallet must have code (a call to an empty address would "succeed"). It passes only on a blocking revert
   (`NotRegistered`, `Pinned`, `LimitExceeded`, `WalletCapExceeded`, `PayeeIsContract`), which is recorded. Any other
   revert (for example `Unauthorized`: the env key is not the wallet's Payment role holder) or an undecodable one fails
   the step with its name.

The result is printed first, then written to `.horos/quickstart.json`; if that write fails, the error is reported and
the command exits non-zero. It also exits non-zero when the smoke test fails.

SM-4 timing: `elapsedSeconds` is the time from `start` to the first passing smoke run, set only by that run (null
before it) and frozen afterwards. `underTenMinutes` is `elapsedSeconds < 600`. Without `start`, both stay `null`
(unknown). `start` resets the timer. A corrupt file or a field of the wrong type is reported on stderr and treated as
unset.

## Tests

`pnpm --filter @horos/skill test` runs the matrix with fakes (no network, no chain). After each file, the tests scan
every file written for private keys and API keys. `cli.bin.test.ts` spawns the built binary (`test` depends on this
package's own `build`, see `turbo.json`). `plugin.test.ts` checks the plugin and marketplace manifests and the rules in
SKILL.md. `claude plugin validate packages/skill/plugin` and `claude plugin validate .` also validate the manifests.
