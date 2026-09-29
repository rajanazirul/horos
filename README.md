# Horos

[![CI](https://github.com/rajanazirul/horos/actions/workflows/ci.yml/badge.svg)](https://github.com/rajanazirul/horos/actions/workflows/ci.yml)

The only-tighten safety layer for AI agents that pay in USDC.

Horos screens every counterparty continuously. Hard rules run first, then graded judgment, and the result is a per-counterparty spending limit enforced in a smart contract on Arc. The model can only tighten a limit; only a human can raise one. Horos is non-custodial and is a policy-enforcement tool, not compliance advice.

Early access, built during the Tameion Agents Hackathon (Sep 27 – Oct 10, 2026).

<!-- TODO(founder): fill in both lines after the first deploy (docs/runbooks/railway-deploy.md, step 10). -->
Status: TODO(founder) (not deployed yet; Arc testnet only)
API base URL: TODO(founder)

## Requirements
- Node 24 (`.nvmrc`: 24.21; `engines`: `>=24 <25`)
- pnpm 12.6.0 (pinned in `packageManager`; `corepack enable` or `npx pnpm@12.6.0`)
- Foundry 1.8.3 for `contracts/` (`foundryup --install v1.8.3`)

## Workspace commands
pnpm workspaces + Turborepo. Run from the repo root.

```bash
pnpm install                       # installs every workspace
pnpm turbo run build test lint typecheck
pnpm boundary-lint                 # dependency-boundary lint (AD-1, AD-12)
pnpm --filter @horos/landing dev   # sales page on http://localhost:3000
```

`pnpm boundary-lint` fails when `packages/sdk`, `packages/mcp`, `packages/skill`, `packages/pipeline`, `packages/adapters`, `services/api`, `services/worker` or `apps/log` declares or imports `@horos/owner`; when `packages/core` declares or imports anything other than `@horos/schema` or a relative path; when a relative import leaves its workspace; or when a covered workspace is missing. The rule table lives in `tools/boundary-lint/src/lint.mjs`.

## Contracts
Foundry project in `contracts/` (solc 0.8.37, `evm_version = "osaka"`, OpenZeppelin 5.6.1). The libraries are git submodules:

```bash
git submodule update --init          # forge-std and OpenZeppelin (no --recursive needed)
cd contracts
forge build
forge test -vvv
```

The gitlink commits pin the versions: `contracts/lib/forge-std` is tag v1.16.2 (`bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`) and `contracts/lib/openzeppelin-contracts` is tag v5.6.1 (`5fd1781b1454fd1ef8e722282f86f9293cacf256`). To upgrade, check out the new tag inside the submodule and commit the gitlink.

`contracts/src/PolicyWallet.sol` is the customer-owned, non-upgradeable PolicyWallet. Story 1.2 added roles, custody and deposits; Story 1.3 added the Policy setters and `remaining()`; Story 1.4 added `register` and `pay`; Story 1.5 added `tighten`, `pin` / `releasePin`, the Human `setLimit` and the two-step unpin; Story 1.6 added the invariant suite and the Arc fork tests; Story 1.7 added the deploy script `contracts/script/DeployPolicyWallet.s.sol`.

Arc fork tests (`contracts/test/fork/`) run the real USDC `transfer`, which needs Circle's arc-foundry (release v0.8.0-2); upstream `forge test` reports them as skipped. See "Verify the invariant" below for the download, checksum and command (needs access to `rpc.testnet.arc.network`).

## Deploy the Horos Demo wallet

`contracts/script/DeployPolicyWallet.s.sol` deploys a non-upgradeable PolicyWallet on the Standard Preset (500 USDC First-Contact Ceiling, 5,000 USDC Wallet Period Cap, New-Payee Cap 10, 30-day Policy Period, 24h Unpin Delay) with `roleIsContract = false`. It reads the five role holders from `HOROS_*` environment variables, refuses to run on any chain other than Arc testnet (5042002) or a local chain (31337), refuses to broadcast from an account that holds one of the roles, and after deploying checks that the code exists, `human()`, every `roleHolder`, `pendingHuman()` and `policy()` read back equal to the inputs. That read-back runs against forge's local simulation of the deploy, not the chain: step 3 below is the on-chain check. `contracts/test/DeployPolicyWallet.t.sol` runs it in-process under plain `forge test`.

The deployer (`horos-demo-deployer`, `0x137Bb5333a33d0800a3e1aF7db76Eff1b69D307b`) only pays gas. It holds no role, and the wallet has no owner, admin or factory. The Demo roles are EOAs in the founder's own keystores (`~/.foundry/keystores/horos-demo-*`):

| Role | Address |
|---|---|
| Human | `0x3B60Ebece31658EFDA2ad1cD28860CaBbf2E4e85` |
| Payment | `0x705F7d75b1689C42034ca5102700Be481EdCa2DA` |
| Registrar | `0x7434FC9d31FEBe08082A710B255F3Fe51B6a7FfC` |
| Model | `0x081B31405E48eC71bedbc22adf10ebCdcAbB69a7` |
| Rules | `0x9542e0BBC0bCC0c88033233D7d70B0dEf37e2769` |

`arc_testnet` is the `[rpc_endpoints]` alias in `contracts/foundry.toml` for `https://rpc.testnet.arc.io`; `https://rpc.testnet.arc.network` is the secondary Arc testnet endpoint (same chain, chainId 5042002) and can be passed to `--rpc-url` instead.

**1. Broadcast** (the founder runs this; Foundry prompts for the keystore password. Never use `--private-key` or a `.env` holding secrets):

```bash
cd contracts && HOROS_HUMAN=0x3B60Ebece31658EFDA2ad1cD28860CaBbf2E4e85 HOROS_PAYMENT=0x705F7d75b1689C42034ca5102700Be481EdCa2DA HOROS_REGISTRAR=0x7434FC9d31FEBe08082A710B255F3Fe51B6a7FfC HOROS_MODEL=0x081B31405E48eC71bedbc22adf10ebCdcAbB69a7 HOROS_RULES=0x9542e0BBC0bCC0c88033233D7d70B0dEf37e2769 forge script script/DeployPolicyWallet.s.sol:DeployPolicyWallet --rpc-url arc_testnet --account horos-demo-deployer --broadcast
```

The script logs `PolicyWallet deployed at <addr>`. The receipt is in `contracts/broadcast/DeployPolicyWallet.s.sol/5042002/run-latest.json` (git-ignored). After a redeploy, take the new address from that file (`jq -r '.transactions[0].contractAddress' broadcast/DeployPolicyWallet.s.sol/5042002/run-latest.json`) and update `fixtures/horos-demo-wallet.json` before running the steps below.

**2. Verify the source.** Arc's Blockscout offers solc only up to 0.8.36 (checked 2026-09-26), and the stack pins 0.8.37, so verify on Sourcify, which supports Arc testnet:

```bash
cd contracts
ADDR=$(jq -r .policyWallet ../fixtures/horos-demo-wallet.json)
forge verify-contract $ADDR src/PolicyWallet.sol:PolicyWallet --chain-id 5042002 --verifier sourcify --watch
```

Expected: `Status: exact_match`. Check it at `https://sourcify.dev/server/v2/contract/5042002/$ADDR`.

When Blockscout lists `v0.8.37` in `https://explorer.testnet.arc.io/api/v2/smart-contracts/verification/config`, also verify there (no API key needed):

```bash
ARGS=$(cast abi-encode "constructor((address,address,address,address,address),(uint256,uint256,uint256,uint256,uint256),bool)" \
  "(0x3B60Ebece31658EFDA2ad1cD28860CaBbf2E4e85,0x705F7d75b1689C42034ca5102700Be481EdCa2DA,0x7434FC9d31FEBe08082A710B255F3Fe51B6a7FfC,0x081B31405E48eC71bedbc22adf10ebCdcAbB69a7,0x9542e0BBC0bCC0c88033233D7d70B0dEf37e2769)" \
  "(500000000,5000000000,10,30,86400)" false)
forge verify-contract $ADDR src/PolicyWallet.sol:PolicyWallet --chain-id 5042002 \
  --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ --constructor-args $ARGS --watch
```

**3. Read back on chain:**

```bash
# Runtime code equals the local build (roleIsContract = false makes the only immutable 0, so they are identical)
cast code $ADDR --rpc-url arc_testnet | cast keccak
forge inspect PolicyWallet deployedBytecode | cast keccak

# EIP-1967 implementation and admin slots are empty: no proxy
cast storage $ADDR 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url arc_testnet
cast storage $ADDR 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 --rpc-url arc_testnet

# Roles and Policy (Role enum: 0 Payment, 1 Registrar, 2 Model, 3 Rules)
cast call $ADDR "human()(address)" --rpc-url arc_testnet
for r in 0 1 2 3; do cast call $ADDR "roleHolder(uint8)(address)" $r --rpc-url arc_testnet; done
cast call $ADDR "policy()((uint256,uint256,uint256,uint256,uint256))" --rpc-url arc_testnet
```

Expected: the two hashes are equal, both storage slots are `0x0…0`, and the roles and Policy match the table and the Standard Preset. The deployment is recorded in `fixtures/horos-demo-wallet.json`.

The Circle Contracts codehash check (AD-15) is not part of this deploy: without Circle credentials it is logged as a fallback in the maintainer's day-1 checks log (check 2).

## Verify the invariant
The Only-Tighten Invariant: after Registration, no role except the Human can raise a limit, a ceiling or a cap. A Foundry invariant suite fuzzes random call sequences by every role (Human, Payment, Registrar, Model, Rules), by arbitrary callers, and across time jumps of up to 40 days. The handler is `contracts/test/invariant/WalletHandler.sol` and the invariants are in `contracts/test/invariant/PolicyWalletInvariant.t.sol`.

### 1. Upstream Foundry (no network)
Needs Foundry 1.8.3 and the submodules (`git submodule update --init`).

```bash
cd contracts
forge test --match-contract Invariant -vv
```

Expected output (a real run, trimmed to the pass lines): 256 runs × depth 50 and every invariant `[PASS]`. The one `[SKIP]` entry is the fork invariant contract, `PolicyWalletForkInvariantTest`, which only runs under arc-forge with `ARC_FORK=true`. After the pass lines, `WalletHandler successful calls per action` logs the per-action counts of the last run. These counts vary from run to run.

```
Ran 1 test for test/fork/PolicyWalletForkInvariant.t.sol:PolicyWalletForkInvariantTest
[SKIP: skipped] setUp() (gas: 0)
Suite result: ok. 0 passed; 0 failed; 1 skipped; ...

Ran 2 tests for test/invariant/PolicyWalletInvariant.t.sol:PolicyWalletInvariantTest
PolicyWalletInvariantTest invariants:
[PASS] invariant_balanceExitsOnlyViaPayOrWithdraw
[PASS] invariant_balancesCoverGhost
[PASS] invariant_humanEpochOnlyByHuman
[PASS] invariant_newPayeeCapRespected
[PASS] invariant_noNonHumanRaise
[PASS] invariant_pinStateOnlyByRules
[PASS] invariant_pinnedImpliesZeroLimit
[PASS] invariant_registrationOnlyByRegisterOrPin
[PASS] invariant_registrationWithinCeiling
[PASS] invariant_remainingNeverReverts
[PASS] invariant_rolesDistinctAndValid
[PASS] invariant_staleEpochRejected
[PASS] invariant_transitionsExact
[PASS] invariant_unauthorizedCallersRejected
[PASS] invariant_windowSpendWithinLimits
 PolicyWalletInvariantTest invariants (runs: 256, calls: 12800, reverts: 0)
...
[PASS] test_handlerNotVacuous() (gas: ...)
Suite result: ok. 2 passed; 0 failed; 0 skipped; ...

Ran 2 test suites in ...: 2 tests passed, 0 failed, 1 skipped (3 total tests)
```

`reverts: 0` is expected. The handler makes every wallet call as a low-level call and counts a wallet revert as a correct rejection, not a failure, so the handler itself never reverts.

### 2. Arc fork (real USDC)
Upstream Foundry cannot run a real Arc USDC `transfer`, because it calls Arc's NativeCoinAuthority precompile. These tests need Circle's arc-foundry release v0.8.0-2, checked against a pinned sha256. Keep the binary outside the repo:

```bash
mkdir -p ~/.arc-foundry && cd ~/.arc-foundry
# Linux x86_64
curl -sSfL -o arc-foundry.tar.gz https://github.com/circlefin/arc-foundry/releases/download/v0.8.0-2/arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz
echo "088bdb96a84418b757f9825d491e702792f1d1d1e29a9145af305a6600a79556  arc-foundry.tar.gz" | sha256sum -c -
# macOS arm64: use this instead
# curl -sSfL -o arc-foundry.tar.gz https://github.com/circlefin/arc-foundry/releases/download/v0.8.0-2/arc-foundry-v0.8.0-2-aarch64-apple-darwin.tar.gz
# echo "90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87  arc-foundry.tar.gz" | shasum -a 256 -c -
tar -xzf arc-foundry.tar.gz forge

cd <repo>/contracts
ARC_FORK=true ~/.arc-foundry/forge test --network arc --match-path 'test/fork/*' -vv
```

The checksum line must print `arc-foundry.tar.gz: OK`. Do not run the binary if it prints anything else. Expected output (a real run, pass lines only): 27 tests pass and none are skipped.

```
Ran 3 tests for test/fork/PayArcFork.t.sol:PayArcForkTest
[PASS] test_fork_payExactRemainingThenOneMoreReverts() (gas: 510113)
[PASS] test_fork_payUnregisteredReverts() (gas: 258040)
[PASS] test_fork_usdcIsSixDecimals() (gas: 19142)
Ran 16 tests for test/fork/PolicyWalletForkInvariant.t.sol:PolicyWalletForkInvariantTest
[PASS] invariant_balanceExitsOnlyViaPayOrWithdraw() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_balancesCoverGhost() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_humanEpochOnlyByHuman() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_newPayeeCapRespected() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_noNonHumanRaise() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_pinStateOnlyByRules() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_pinnedImpliesZeroLimit() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_registrationOnlyByRegisterOrPin() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_registrationWithinCeiling() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_remainingNeverReverts() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_rolesDistinctAndValid() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_staleEpochRejected() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_transitionsExact() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_unauthorizedCallersRejected() (runs: 8, calls: 200, reverts: 0)
[PASS] invariant_windowSpendWithinLimits() (runs: 8, calls: 200, reverts: 0)
[PASS] test_handlerNotVacuous() (gas: 3289553)
Ran 8 tests for test/fork/ArcSurfaceFork.t.sol:ArcSurfaceForkTest
[PASS] testFuzz_fork_allowanceAlwaysZero(address) (runs: 64, μ: 15227, ~: 15227)
[PASS] testFuzz_fork_balanceOfMirrorsNative(uint256) (runs: 256, μ: 18944, ~: 18717)
[PASS] test_fork_blacklistedPayeeBlocksPayAndWithdraw() (gas: 579170)
[PASS] test_fork_eoaTransfersToBlacklistedRevert() (gas: 94650)
[PASS] test_fork_permitOnBehalfOfWalletReverts() (gas: 63194)
[PASS] test_fork_transferWithAuthorizationFromWalletReverts() (gas: 36913)
[PASS] test_fork_walletHasNoErc1271() (gas: 6097)
[PASS] test_fork_withdrawToCleanAddressSweeps() (gas: 66478)
Ran 3 test suites in ...: 27 tests passed, 0 failed, 0 skipped (27 total tests)
```

The gas figures and fuzz averages can differ slightly, and the suites may print in a different order. CI runs both: the `contracts` job runs the upstream suite, and the `arc-fork` job runs the fork command with the same pinned checksum.

### What each invariant means
The handler checks the first eleven after every call. Each has its own flag, and a failure prints the first reason and the action that caused it.
- `invariant_noNonHumanRaise`: no call except a Human call raised a limit or changed the Policy, including from a pinned or zero-limit state. The one exception is a first Registration, capped at the ceiling.
- `invariant_registrationWithinCeiling`: an automated `register` never stored a limit above the First-Contact Ceiling in force.
- `invariant_windowSpendWithinLimits`: after each `pay`, the Counterparty's spend in the window `[today − N, today]` is within its Effective Limit, and the wallet's spend is within the Wallet Period Cap.
- `invariant_balanceExitsOnlyViaPayOrWithdraw`: balances fall only through `pay` (the token balance by exactly `amount`) and `withdraw` (the native balance to 0).
- `invariant_staleEpochRejected`: a successful `tighten` always carried the current `humanEpoch`.
- `invariant_humanEpochOnlyByHuman`: no call except a Human call changed `humanEpoch` or `humanSet`.
- `invariant_pinStateOnlyByRules`: among non-Human calls, only `pin` sets a pin and only `releasePin` clears one, each only on its target. `unpinRequestedAt` changes only when one of them clears it, and `pin` leaves the limit at 0.
- `invariant_registrationOnlyByRegisterOrPin`: among non-Human calls, `registered` changes only through `register` or `pin` on the target.
- `invariant_newPayeeCapRespected`: new Registrations with a limit above 0 in the window never exceed the New-Payee Cap.
- `invariant_unauthorizedCallersRejected`: a caller without the role never succeeds at any mutator.
- `invariant_transitionsExact`: `register` stores exactly the requested limit, and `tighten` stores exactly `min(before, requested)`.
- `invariant_rolesDistinctAndValid`: the Human, the pending Human and the four role holders are pairwise distinct, and none of them is `0`, the wallet or USDC. Vacant slots are exempt.
- `invariant_pinnedImpliesZeroLimit`: a pinned Counterparty always has a limit of 0.
- `invariant_remainingNeverReverts`: `remaining(a)` never reverts, including for `0`, the wallet and USDC.
- `invariant_balancesCoverGhost`: the ghost outflows never exceed the ghost inflows. The balances are at least deposits minus withdrawals (native) and minted minus paid (USDC).
- `test_handlerNotVacuous`: each of the 21 handler actions succeeds when called once with valid inputs, and no property is flagged. For `arbitrary`, success means the wallet rejected the stranger with `Unauthorized`. This proves every action can reach the wallet; it does not measure how often each one succeeds during fuzzing.

## CI
`.github/workflows/ci.yml` runs on every push and pull request: install with the frozen lockfile, the boundary lint, lint, typecheck, vitest, build (including the landing static export), then `forge build`, `forge test` (without the invariant suite) and a separate invariant-suite step with Foundry 1.8.3. A separate `arc-fork` job downloads arc-foundry v0.8.0-2, checks it against a sha256 pinned in the workflow, and runs the Arc fork tests and the fork invariant.

## Hosted deployment
The api and worker run on Railway from one `Dockerfile`, with per-service config in `railway/api.json` and `railway/worker.json`. The worker runs `node services/worker/dist/migrate.js` as its pre-deploy step (migrations as a non-superuser migrator role, under an advisory lock); the api never holds the migrator login, and its `/healthz` answers 503 `schema-behind` until the schema has caught up. Both services validate their environment at boot and exit 1 naming any invalid variable, without printing values; the api refuses to start if a Circle secret, the migrator URL or local signer keys are in its environment. `.github/workflows/smoke.yml` is a manual smoke test against the hosted api. The founder steps (Railway project, database roles, variables, backups, restore drill, Demo wallet onboarding) are in `docs/runbooks/railway-deploy.md`.

## Layout
| Path | What |
|---|---|
| `apps/landing` | Sales page (Next.js 16, static export to `apps/landing/out`) |
| `apps/log` | Read-only Decision Log view (placeholder) |
| `services/api`, `services/worker` | API (`dist/server.js`) and worker (`dist/main.js`, `dist/migrate.js`) services |
| `packages/schema` | Wire and domain types, EIP-712 types, record hashing (placeholder) |
| `packages/core` | Pure rules and Policy; depends only on `schema` (placeholder) |
| `packages/pipeline`, `packages/adapters` | Pipeline runner and adapters (placeholders) |
| `packages/sdk`, `packages/mcp`, `packages/skill` | Client SDK, MCP server, Claude Code skill (placeholders) |
| `packages/owner` | Human role CLI, isolated custody domain (placeholder) |
| `contracts` | Foundry project for the PolicyWallet |
| `tools/boundary-lint` | Dependency-boundary lint |
| `tools/verify` | Record-chain verifier (`horos-verify`) |
| `tools/ops` | Backup, restore drill and all-Scope chain verification for the hosted database |
| `Dockerfile`, `railway/` | One image for both services; Railway config-as-code per service |
| `docs/research` | Market notes, hackathon brief, stack considerations |
| `docs/runbooks` | Railway deploy runbook |

## Licence
Apache-2.0 (see `LICENSE`). It covers the whole repository, including `contracts/`, `packages/sdk` and `packages/mcp`.
