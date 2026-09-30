---
name: horos-quickstart
description: Wire Horos into an existing agent that pays in USDC, in under ten minutes. Use when the developer asks to add Horos, add a Horos check before a USDC payment, set up a PolicyWallet, or try Horos Shadow Mode in their agent repo. Runs the horos-quickstart CLI (timer, preflight, deploy, Shadow sign-up, smoke test) and inserts a `check()` before the agent's USDC transfer.
---

# Horos quickstart

Horos answers one question before an agent pays: `check(counterparty, amount)` returns **allow / cap / hold / block**
with a reason, and (enforced mode) writes a per-Counterparty Limit to the agent's own PolicyWallet contract, which the
agent pays through. Horos is a policy-enforcement and evidence tool; the developer stays the compliance
decision-maker. Do not describe Horos as making anyone compliant.

You drive the integration in the developer's agent repo. The `horos-quickstart` CLI does every deterministic step;
your job is to choose the mode with the developer, find the agent's USDC transfer, and insert the Horos code.

## Running the CLI

The Horos packages are not on npm yet. Use a local checkout of the Horos repository (ask the developer for its path
once), built with `pnpm install && pnpm --filter @horos/skill... build`, and run from the agent repo's root:

```sh
node <horos-checkout>/packages/skill/dist/cli.js <command>
```

After publication, `npx --package @horos/skill horos-quickstart <command>` will do the same. Below,
`horos-quickstart` means whichever form works. The CLI loads a `.env` file in the agent repo's root (without
overriding variables already set in the shell).

## Key rules (never break these)

1. **The Payment key comes only from the environment**: `HOROS_PAYMENT_PRIVATE_KEY` (the agent's own key, in the
   shell or a gitignored `.env`), or, on the Circle path, the developer's own Circle client code. Never ask the
   developer to paste a key into the chat, never write a key or an API key into any file, never print one.
2. **Never ask for, read or accept the Human (Policy Owner) private key.** Ask only for the Human's **address**. If
   the developer offers a key or a seed phrase, refuse, do not repeat it, and tell them to treat it as exposed. The
   Human key lives in a separate custody domain (for example a hardware wallet) that the agent's runtime, this repo and
   its environment can never reach. `horos-quickstart deploy --human` refuses a 32-byte hex value.
3. **Never install `@horos/owner` in the agent repo** and never add it to any `package.json` field. Human tooling stays
   on the Policy Owner's own machine. The CLI refuses to run if it is present.
4. `.env*` must be gitignored and untracked; `preflight` fails otherwise.
5. The CLI never edits the agent's source. You do, and only after showing the developer the full diff (steps 5 and 6).
6. No USDC moves in the quickstart. The enforced smoke test does make one on-chain change: its known-good Check is
   enforced, so Horos queues one first-contact Limit write for that address (one new-payee slot on the PolicyWallet,
   reused across reruns). The `pay` step is a simulation only.

## Steps (in this order)

### 1. Start the timer

```sh
horos-quickstart start
```

Do this first: SM-4 measures from the start of the skill to the first passing smoke test (target: 10 minutes). It
records the start time in `.horos/quickstart.json`.

### 2. Preflight

```sh
horos-quickstart preflight
```

It checks Node >= 20.12, a `package.json`, no `@horos/owner` (in any dependency field or `node_modules`), and that
`.env*` files anywhere in the repo are gitignored and not tracked by git. Fix every `FAIL` line it prints (for
`.env*`, add the line `.env*` to `.gitignore`; for a tracked file, `git rm --cached <file>` and treat its keys as
exposed), then rerun until it passes.

### 3. Choose enforced or Shadow

Ask the developer once:

- **Enforced**: a PolicyWallet is deployed; the agent pays through `PolicyWallet.pay`, which enforces the Limits Horos
  writes. Needs the Policy Owner's (Human) address, a little testnet gas in the Payment EOA, and, before live use,
  USDC in the PolicyWallet.
- **Shadow**: no contract, no change to how the agent pays. Checks are advisory and recorded, so the developer can see
  what Horos would have done. Good for teams not ready to move funds.

### 4. Install the SDK

While the packages are unpublished, install `@horos/sdk` from the local checkout with the repo's own package manager
(match the lockfile), for example `npm install <horos-checkout>/packages/sdk` or
`pnpm add file:<horos-checkout>/packages/sdk` (in a pnpm workspace that includes the checkout, `workspace:*`). After
publication: `npm install @horos/sdk`. The insertion code also needs `viem` (2.x); add it if the agent does not
already use it. Install nothing else from Horos.

### 5. Enforced path

1. Make sure `HOROS_BASE_URL` (the api origin only, no path) and `HOROS_PAYMENT_PRIVATE_KEY` are set in the shell or
   the gitignored `.env` (ask the developer to set them; do not read or print the key). `HOROS_RPC_URL` is optional
   on Arc testnet.
2. Ask ONLY for the Policy Owner's Human **address** (0x + 40 hex). It must not be the Payment address.
3. Deploy and bind:

   ```sh
   horos-quickstart deploy --human <address>
   ```

   It writes `horos.config.json` (public values only: `baseUrl`, `chainId`, `policyWallet`, `scope`, `customerId`,
   `mode`) and prints the deploy report. Show the developer the report's codehash, role holders and funding steps.
   Tell them not to fund the PolicyWallet until they have checked the report on the explorer. If
   `horos.config.json` already names a PolicyWallet, `deploy` refuses (a rerun would deploy a second wallet); keep the
   existing one unless the developer explicitly wants a new one (`--force`).
4. **Find the agent's USDC transfer.** Search the source for the payment call: an ERC-20 `transfer` to the USDC
   address (Arc testnet USDC is `0x3600000000000000000000000000000000000000`), `writeContract({ functionName:
   "transfer" })`, a Circle `createTransaction` / transfer call, an x402 payment, or a helper that wraps one of these.
   If there are several, ask which one(s) to gate.
5. **Insert `check()` before it and route the payment through `PolicyWallet.pay`** using the pattern below. Show the
   developer the full diff and wait for approval before writing it.
6. Smoke test:

   ```sh
   horos-quickstart smoke
   ```

   It Checks a known-good address (expects `allow`; a random address generated once and reused on reruns, or
   `--good <address>`), Checks the first address of the Horos Demo List (a labelled, fictional test list; expects
   `block`, `simulated: true`), and simulates a forced `PolicyWallet.pay` to that Demo List address (no transaction
   sent; it must revert with a blocking reason such as `NotRegistered` or `Pinned`, which is recorded). `--amount
   <usdc>` sets the Check amount (default 1).

Enforced insertion pattern. It is ESM (`import`, top-level `await`, JSON import attributes: Node >= 20.12 with
`"type": "module"`, or the equivalent in the agent's build) and uses `viem`. Adapt names to the codebase; keep the
logic:

```ts
import { createHoros, fromViemAccount, type Hex } from "@horos/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import horosConfig from "../horos.config.json" with { type: "json" };

const paymentAccount = privateKeyToAccount(process.env.HOROS_PAYMENT_PRIVATE_KEY as Hex); // from env only
const horos = createHoros({
  baseUrl: horosConfig.baseUrl,
  chainId: horosConfig.chainId,
  policyWallet: horosConfig.policyWallet,
  scope: horosConfig.scope,
  signer: fromViemAccount(paymentAccount),
});
const policyWallet = horosConfig.policyWallet as Hex;
// Reuse the agent's existing viem clients if it has them (same chain, the Payment account).
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(process.env.HOROS_RPC_URL) });
const walletClient = createWalletClient({ account: paymentAccount, chain: arcTestnet, transport: http(process.env.HOROS_RPC_URL) });

const policyWalletAbi = [
  { type: "function", name: "pay", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "a", type: "address" }, { name: "amount", type: "uint256" }, { name: "recordHash", type: "bytes32" }] },
  { type: "function", name: "remaining", stateMutability: "view", inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "cpRemaining", type: "uint256" }, { name: "walletRemaining", type: "uint256" },
      { name: "newPayeeRemaining", type: "uint256" }, { name: "limit", type: "uint256" }, { name: "pinned", type: "bool" },
      { name: "registered", type: "bool" }, { name: "humanSet", type: "bool" }, { name: "humanEpoch", type: "uint256" }] }] },
] as const;

// Before the agent's USDC transfer (amount in USDC base units: 1 USDC = 1_000_000n):
// 1. Check.
const res = await horos.check({ counterparty, amount });
// 2. Stop unless allow or cap (hold and block mean: do not pay). An advisory answer is not enforcement.
if (res.advisory || (res.decision !== "allow" && res.decision !== "cap")) {
  throw new Error(`Horos ${res.decision}: ${res.reason}`); // or the agent's own "payment refused" path
}
// 3. Pay min(amount, payable_amount).
const payAmount = res.decision === "cap" && res.payable_amount !== undefined && BigInt(res.payable_amount) < amount
  ? BigInt(res.payable_amount)
  : amount;
// 4. Wait until the Limit write is confirmed on-chain (a first contact queues a register; pay reverts NotRegistered
//    until it lands), reading the Decision Record's hash on the way.
let recordHash: Hex | undefined;
for (const deadline = Date.now() + 180_000; ; ) {
  const detail = await horos.getRecord(res.record_id);
  recordHash = detail.recordHash;
  if (detail.receipts.some((r) => r.status !== "confirmed" && r.status !== "noop")) throw new Error("Horos Limit write failed: not paying");
  const r = await publicClient.readContract({ address: policyWallet, abi: policyWalletAbi, functionName: "remaining", args: [counterparty] });
  if (r.pinned) throw new Error("Counterparty pinned: not paying");
  if (r.registered && r.cpRemaining >= payAmount && r.walletRemaining >= payAmount) break;
  if (Date.now() > deadline) throw new Error("Limit not confirmed in time: not paying");
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
// 5. Pay through the PolicyWallet with the record's hash, and wait for the receipt.
const hash = await walletClient.writeContract({
  address: policyWallet,
  abi: policyWalletAbi,
  functionName: "pay",
  args: [counterparty, payAmount, recordHash],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`PolicyWallet.pay reverted (${hash})`);
// This REPLACES the direct USDC transfer: the PolicyWallet holds the USDC and pays out within its Limits.
```

The PolicyWallet must hold USDC before live use (the deploy report's funding steps), and the Payment EOA needs a
little gas. The SDK's `examples/check-and-pay.ts` is the full reference for this flow.

**Circle Payment path.** If the Payment key is a Circle developer-controlled wallet, the CLI cannot deploy for you
(it does not import Circle SDKs). Put this in the developer's own script, with the Circle credentials from their
environment, then write `horos.config.json` from the result (public values only) and use
`circleDcwSigner({ client, walletId, address })` as the `signer` in the pattern above:

```ts
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";
import { deployPolicyWallet } from "@horos/sdk";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";

const circle = { apiKey: process.env.CIRCLE_API_KEY!, entitySecret: process.env.CIRCLE_ENTITY_SECRET! };
const result = await deployPolicyWallet({
  baseUrl: process.env.HOROS_BASE_URL!,
  chainId: arcTestnet.id,
  humanAddress: "0x…", // the Policy Owner's address only
  payment: { kind: "circle", wallets: initiateDeveloperControlledWalletsClient(circle), contracts: initiateSmartContractPlatformClient(circle) },
  publicClient: createPublicClient({ chain: arcTestnet, transport: http(process.env.HOROS_RPC_URL) }),
});
// horos.config.json: { baseUrl, chainId, policyWallet: result.policyWallet, scope: result.scope, customerId: result.customerId, mode: "enforced" }
```

The Human address must not belong to the same Circle account or API key as the Payment wallet. `horos-quickstart
smoke` signs with `HOROS_PAYMENT_PRIVATE_KEY`, so on the Circle path run the two smoke Checks from the developer's own
code instead.

### 6. Shadow path

1. Make sure `HOROS_BASE_URL` and `HOROS_PAYMENT_PRIVATE_KEY` are set (sign-up is signed by the Payment key).
2. Sign up:

   ```sh
   horos-quickstart shadow
   ```

   It writes the API key to a file outside the repo that only the developer can read (default
   `~/.config/horos/shadow-api-key`; `--key-file <path>` to choose another path outside the repo). The key is never
   printed. It then prints that path with an `export HOROS_API_KEY="$(cat <path>)"` line, and writes
   `horos.config.json` with `mode: "shadow"` and the shadow Scope (no key in it). Tell the developer the key is in that
   file and that they should load it with the export line. **Never read, `cat` or print the key file yourself, and tell
   the developer never to paste the key into the chat.** If the CLI answers that Shadow Mode is closed, the Customer already
   has a bound PolicyWallet: use the enforced path. A rerun issues a new key and revokes the old one.
3. Insert an **advisory** Check before the transfer and leave the transfer itself unchanged. Show the diff first:

   ```ts
   import { createHoros } from "@horos/sdk";
   import horosConfig from "../horos.config.json" with { type: "json" };

   const horos = createHoros({
     baseUrl: horosConfig.baseUrl,
     chainId: horosConfig.chainId,
     scope: horosConfig.scope,
     apiKey: process.env.HOROS_API_KEY, // from env only
   });

   // Before the agent's existing USDC transfer: log only, never block or change the payment in Shadow Mode.
   try {
     const res = await horos.check({ counterparty, amount });
     console.log(`horos shadow: ${res.decision} (${res.outcome ?? "advisory"}): ${res.reason} [record ${res.record_id}]`);
   } catch (err) {
     console.warn("horos shadow check failed", err instanceof Error ? err.message : err);
   }
   // ...the existing transfer, unchanged...
   ```

4. Smoke test (advisory Checks only; nothing on-chain, no pay simulation):

   ```sh
   horos-quickstart smoke --shadow
   ```

### 7. Report the elapsed time

`smoke` prints the elapsed time and records `elapsedSeconds` and `underTenMinutes` in `.horos/quickstart.json`,
measured from `start` to the first passing smoke test (later runs do not change it). Tell the developer the number,
whether the smoke test passed, and, if it failed, the failing step and its message. If `start` was never run, the
elapsed time is recorded as unknown.

`horos.config.json` holds public values only and may be committed. `.horos/` is local run state; it may be
gitignored.

## If something fails

- A `FAIL` or error names the variable or the step; fix that and rerun. `preflight`, `start` and `smoke` are safe to
  rerun. `deploy` refuses to deploy a second PolicyWallet unless `--force`. `shadow` issues a new key and revokes the
  previous one on every run.
- Never work around a refusal about the Human key, `@horos/owner`, `.env*` or secrets in files.
- `smoke` failing at `good` with an advisory answer usually means `HOROS_PAYMENT_PRIVATE_KEY` is not this
  PolicyWallet's Payment key or the wallet is not bound. Failing at `pay` with "did NOT revert" means the PolicyWallet
  would let a Demo List payment through: stop and tell the developer.
