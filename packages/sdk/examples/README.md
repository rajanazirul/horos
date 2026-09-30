# Example: check, then pay

`check-and-pay.ts` performs one signed Horos Check and, when the decision is `allow` or `cap`, pays the
Counterparty through your PolicyWallet on Arc testnet:

1. `horos.check({ counterparty, amount })`. It stops unless the answer is enforced (`advisory: false`) and the
   decision is `allow` or `cap`. On `cap` it pays `min(amount, payable_amount)`.
2. Polls `horos.getRecord(record_id)` and the wallet's `remaining(counterparty)` until the Counterparty is
   Registered with room for the payment (the Check's register intent confirmed, or it was already registered). It
   stops if the record's Limit write failed, the counterparty is pinned, or the wallet period cap is too low.
3. Calls `PolicyWallet.pay(counterparty, amount, recordHash)` from the Payment key and prints the tx hash and an
   explorer link.

## Run

Needs Node 24, a built SDK, a PolicyWallet that is deployed, bound to Horos and funded with test USDC, and a
little testnet gas on the Payment EOA.

```sh
pnpm install && pnpm turbo run build --filter @horos/sdk...

HOROS_BASE_URL=https://api.example.com \
HOROS_PAYMENT_KEY=0x… \
HOROS_POLICY_WALLET=0x… \
HOROS_SCOPE=enforced:… \
ARC_RPC_URL=https://… \
HOROS_COUNTERPARTY=0x… \
HOROS_AMOUNT=1000000 \
node packages/sdk/examples/check-and-pay.ts
```

| Variable | Meaning |
|---|---|
| `HOROS_BASE_URL` | Horos api origin |
| `HOROS_PAYMENT_KEY` | Private key of the wallet's Payment role holder. Read from the environment only, never printed. Keep it out of the repo and shell history. |
| `HOROS_POLICY_WALLET` | Your PolicyWallet address |
| `HOROS_SCOPE` | Your enforced Scope id (`enforced:<uuid>`), returned by onboarding. Used to read the record hash. |
| `ARC_RPC_URL` | Arc testnet RPC endpoint |
| `HOROS_COUNTERPARTY` | Address to pay |
| `HOROS_AMOUNT` | USDC base units (1 USDC = `1000000`) |

Exit codes: `0` paid, `1` a failure (api or RPC error, timeout, reverted tx), `2` not paid by decision or policy
(`hold`, `block`, advisory answer, nothing payable, a failed Limit write, a counterparty pinned by the Human role,
or the wallet period cap leaving too little).
