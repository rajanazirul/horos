# @horos/sdk

Typed TypeScript client for the Horos api. One call before your agent pays: `check(counterparty, amount)` returns
`allow`, `cap`, `hold` or `block` with a reason and a confidence, and the api queues the matching per-counterparty
Limit for your PolicyWallet. The transfer itself goes through your own `PolicyWallet.pay`, which enforces that Limit
on-chain.

The package is workspace-only for now (`private`, not yet published to npm): use it from this monorepo.

Horos is a policy-enforcement and evidence tool. It does not make you compliant: you remain the compliance
decision-maker, and a Declared Identity is always unverified.

## Usage

```ts
import { createHoros, fromViemAccount, HorosError } from "@horos/sdk";
import { privateKeyToAccount } from "viem/accounts";

const horos = createHoros({
  baseUrl: "https://api.example.com",
  chainId: 5042002, // Arc testnet
  policyWallet: "0x…", // your PolicyWallet
  signer: fromViemAccount(privateKeyToAccount(process.env.HOROS_PAYMENT_KEY as `0x${string}`)),
  scope: "enforced:…", // from onboarding; the default Scope for the read methods
});

const res = await horos.check({
  counterparty: "0x…",
  amount: 25_000_000n, // USDC base units (6 dp): 25 USDC
  declaredIdentity: { name: "Acme Supplies" }, // optional, unverified
});
// res.decision, res.effective_limit, res.remaining, res.reason, res.confidence, res.record_id, res.advisory,
// res.simulated, res.limit_write, res.chain_state, res.payable_amount (on cap)

const { recordHash } = await horos.getRecord(res.record_id); // pass to PolicyWallet.pay(counterparty, amount, recordHash)
```

Amounts are `bigint` base units in the API and decimal strings on the wire. Every response is validated against
the `@horos/schema` wire types.

`examples/check-and-pay.ts` runs a Check and a `PolicyWallet.pay` end to end on Arc testnet (see
`examples/README.md`).

## Signers

The signer is your **Payment** key. The SDK never generates or stores keys.

- `fromViemAccount(account)`: any viem local account.
- `circleDcwSigner({ client, walletId, address })`: a Circle developer-controlled EOA. `client` is anything with
  `signTypedData({ walletId, data })`, such as the client from `initiateDeveloperControlledWalletsClient`; the SDK
  does not depend on the Circle SDK.

Every signature is checked to recover to the signer's address before anything is sent (otherwise the api would
silently answer advisory).

**No Human-domain signing.** Both signers refuse every EIP-712 domain except "Horos Check" and "Horos Account".
Nothing in this package signs or builds a Human action (raising a Limit, unpinning, changing Policy): those need
the Human key, which must never be reachable from your agent's runtime.

## Envelope and retries

Each `check()` signs a fresh envelope: a 32-byte random nonce and a whole-second expiry, 120 s by default
(`expirySeconds`, 7 to 300). The expiry comes from the local clock, so keep the host NTP-synced: a skewed clock
makes the api reject the signature window and answer advisory.

On an error whose envelope says `retryable: true` (for example `judge_unavailable`, `unavailable`, `internal`,
`rate_limited`), a network failure or a non-JSON response, the SDK resends the **byte-identical** request: same
nonce, same signature. The api consumes the nonce only when it writes the enforced record, so a resend after a
failure that wrote nothing is still enforced. Backoff starts at 250 ms and doubles up to 4 s; a `Retry-After` on a
retryable response is honoured as a minimum wait. Each attempt times out after 30 s. A 200 whose body does not
match the schema is not retried (the record is already written) and throws a non-retryable `unavailable`. Retries stop 5 s before the envelope expires, and the SDK then throws `HorosError` with `code`,
`retryable`, `status` and `attempts`. Non-retryable errors and invalid input (checked before any request, code
`validation_failed`) throw at once.

If a response is lost after the api wrote the record, the resend is a replay and comes back `advisory: true`.
Treat an advisory answer as "not enforced": do not rely on it to pay.

## Advisory mode and the read methods

`signer` is optional. Without one, the client is **advisory**: `check()` sends a request with no `auth`, the api
answers from its advisory-public Scope (`advisory: true`, `limit_write: "none"`), nothing is written on-chain and the
answer is not enforcement. `policyWallet` then defaults to the zero address; with a signer it stays required.
`horos.signed` tells the two apart.

Read-only Decision Log access, validated against `@horos/schema`:

```ts
const page = await horos.listRecords({ scope, after, limit }); // RecordPage; pass nextCursor as `after`
const detail = await horos.getRecord(recordId, { scope }); // RecordDetail (any valid Scope)
const cps = await horos.listCounterparties({ scope, after, limit }); // CounterpartyStatusPage
const status = await horos.getCounterparty(address, { scope }); // CounterpartyStatusView
```

`scope` defaults to the one passed to `createHoros`; with neither, the call throws `validation_failed` before any
request. `limit` is 1..100. With a signer each read carries a signed ReadAccess; without one no auth headers are
sent, which the api accepts only for its public demo Scope (a private Scope answers `unauthenticated`).

## Shadow Mode

For a team not ready to route payments through a PolicyWallet. Shadow Mode never touches the chain and never changes
the payment path: Checks run the same pipeline in the Customer's own `shadow:<customerId>` Scope, every answer is
`advisory: true` with `limit_write: "none"`, and Limits and spend live in a Postgres virtual ledger (the contract's
rolling-window arithmetic, ported). It is not enforcement.

```ts
import { createHoros, fromViemAccount, shadowSignup } from "@horos/sdk";

// Once: the Payment key signs up and gets an API key (shown once; a new sign-up revokes the previous key).
const { scope, apiKey } = await shadowSignup({ baseUrl, chainId: 5042002, signer: fromViemAccount(paymentAccount) });

// Then: no signer needed. Keep the key out of the repo and logs (e.g. an env var).
const horos = createHoros({ baseUrl, chainId: 5042002, apiKey, scope });
const res = await horos.check({ counterparty, amount: 50_000_000n }); // advisory, nothing on-chain
const log = await horos.listRecords(); // the shadow Decision Log, read with the same key
const counts = await horos.getShadowSummary(); // { advisory, would_have_caught }
```

`apiKey` and `signer` are exclusive. Each shadow answer carries `outcome`: `advisory` or `would-have-caught` (a hold
or block that is not a Horos Demo List simulation). A shadow Check has no nonce, so the client resends it only on a
retryable error envelope; a network failure or timeout throws `unavailable` saying the Check may or may not have been
recorded. `shadowSignup` is never resent after a transport failure either: if its outcome is unknown, sign up again. Once the Customer's PolicyWallet is bound, both sign-up and shadow
Checks answer `shadow_closed`: nothing migrates, and the enforced Scope never reads the virtual ledger.

## Deploying a PolicyWallet

`deployPolicyWallet` takes you from the Policy Owner's (Human) address to a bound, enforced PolicyWallet on the standard
Preset (500 USDC first-contact ceiling, 5,000 USDC per 30 days, 10 new payees per period, 24 h unpin delay), without
writing Solidity. It:

1. before any network write, checks that the public client, the wallet client (EOA path) or the Circle blockchain
   (Circle path: `ARC-TESTNET` for chain 5042002) are on `chainId`, that the Human address is an EOA, and that
   custody separation holds (see below);
2. onboards your Payment key with the api (a Payment-signed "Horos Account" request) and waits, re-posting, until
   your per-Customer Horos Registrar, Model and Rules addresses are provisioned; it then refuses if the Human
   address is one of them;
3. deploys the PolicyWallet with all five roles and the standard Preset, from your Payment key;
4. checks the deployed runtime codehash against the pinned PolicyWallet build, and reads the five role holders and
   the Policy back from the chain;
5. binds the wallet to your enforced Scope through the api;
6. prints the codehash, the five role holders, the Policy, explorer links and then the funding instructions.

`timeoutMs` (default 5 minutes) applies to each phase separately: key provisioning, the deploy, and the bind.

If step 4 finds any mismatch it throws `HorosError('conflict')`, does not bind, and prints no funding instructions.

### Payment key: two sources

**A Circle developer-controlled EOA** (the default). Pass clients created under **your own** Circle account: the
developer-controlled-wallets client (creates the Payment EOA and signs) and the Smart Contract Platform client
(deploys through Circle Contracts). The SDK does not depend on the Circle SDK; any object with the same methods works.

```ts
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";
import { deployPolicyWallet } from "@horos/sdk";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";

const circle = { apiKey: process.env.CIRCLE_API_KEY!, entitySecret: process.env.CIRCLE_ENTITY_SECRET! };
const result = await deployPolicyWallet({
  baseUrl: "https://api.example.com",
  chainId: arcTestnet.id,
  humanAddress: "0x…", // the Policy Owner's EOA: yours, held outside the agent's runtime
  payment: {
    kind: "circle",
    wallets: initiateDeveloperControlledWalletsClient(circle),
    contracts: initiateSmartContractPlatformClient(circle),
    // wallet: { id: "…", address: "0x…" }, // to reuse an existing Circle EOA instead of creating one
  },
  publicClient: createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) }),
});
// result.policyWallet, result.scope → createHoros({ policyWallet, scope, ... })
```

Wallet creation and the deploy carry deterministic Circle idempotency keys, so rerunning after an interruption does
not create a second wallet or contract. The wallet keys derive from the Human address; the deploy key covers the
Payment, Human, Registrar, Model and Rules addresses, the blockchain and the pinned codehash, so changed roles or
bytecode never reuse an old contract. If Circle reports a deploy FAILED, that run throws with the contract id; the
next run skips the failed record and submits one new deploy. A rerun after a successful bind verifies the bound
wallet again and re-binds it (the api answers 200).

**An existing EOA.** Pass a viem local account and a wallet client; the deploy is a plain viem `deployContract`
from that account.

```ts
import { deployPolicyWallet } from "@horos/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const account = privateKeyToAccount(process.env.HOROS_PAYMENT_KEY as `0x${string}`);
const transport = http(process.env.ARC_RPC_URL);
await deployPolicyWallet({
  baseUrl: "https://api.example.com",
  chainId: arcTestnet.id,
  humanAddress: "0x…",
  payment: { kind: "eoa", account, walletClient: createWalletClient({ account, chain: arcTestnet, transport }) },
  publicClient: createPublicClient({ chain: arcTestnet, transport }),
});
```

In both cases the Payment EOA is the deployer and pays the gas; no Horos key is involved in the deploy.

On the EOA path there is no idempotency record: if a run is interrupted after the deploy transaction is sent but
before the bind, a rerun deploys a second contract. Every error thrown after sending carries the deploy transaction
hash (and the contract address once known), so you can see what the first attempt created.

### Custody separation

The Policy Owner (Human role) is the only role that can raise a Limit, so its key must live where your agent cannot
reach it. You pass only its **address**: the SDK never generates, stores or signs for it. In v1 the Human must be an
EOA: the PolicyWallet is deployed with `roleIsContract = false`, so a contract (for example a Safe) is refused. The
helper refuses with `HorosError('validation_failed')` and an explanation when the Human address:

- has contract code (checked before any network write);
- equals the Payment address (before any network write);
- is a wallet under the same Circle account as the Payment wallet (checked with `listWallets` on the Circle path,
  before any Circle create or deploy);
- equals one of your Horos Registrar, Model or Rules addresses (checked after onboarding, before the deploy).

### Funding comes last

The helper never moves funds. Fund only after the printed codehash and role holders check out: send USDC to the
PolicyWallet from any wallet, and keep a little USDC in the Payment EOA for gas.

If the codehash, a role holder or the Policy does not match, the helper throws `HorosError('conflict')` without
binding. On a wallet that was already bound (a rerun), a mismatch is reported as drift on a live wallet.

The ABI, creation bytecode and expected codehash come from `src/generated/policy-wallet-artifact.ts`, generated by
`pnpm --filter @horos/sdk artifact:generate` after `forge build`. The generator refuses to write if the runtime
codehash differs from `fixtures/horos-demo-wallet.json`, and CI fails if the file drifts from the contract build.
