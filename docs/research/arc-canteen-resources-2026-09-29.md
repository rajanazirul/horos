# Arc Canteen builder hub: what matters for Horos

Checked on 2026-09-29. Sources: https://arc-canteen.dev/, the `arc-canteen` CLI 0.1.17 (PyPI) and its context bundle (`arc-canteen context sync` → `~/.arc-canteen/context/`, upstream `the-canteen-dev/context-arc`), and a clone of `dolepee/arc-mirror-kit` at its default branch.

## 1. Circle Agent Wallets: spending policies do not exist on Arc yet

Circle's Agent Wallets (`developers.circle.com/agent-stack`) ship their own spending policies: per-transaction, daily, weekly and monthly USDC caps, plus recipient and contract allowlists or blocklists (`circle wallet limit set`). Every policy change is confirmed by an email OTP. The Agent Wallets page also states that all transfers are screened against sanctions controls before submission.

Two limits in the docs make this a gap on Arc rather than an overlap:

- "Spending policies require a mainnet agent wallet. Testnet is not supported." (`agent-wallets/wallet-operations/custom-policies.md`)
- Arc is listed as **Arc Testnet only**, with no mainnet identifier (`agent-wallets/supported-blockchains.md`).

So an agent wallet on Arc today has no spending limits at all. Where Circle's policies do exist, they are static and wallet-wide: the same caps for every counterparty, with no graded risk, no re-screening, and a human OTP on each change, so nothing can tighten them automatically.

Positioning consequence: Horos is not a replacement for Circle's controls. It supplies the per-counterparty judgment those controls lack. A later adapter could push Horos `block` decisions into Circle's `recipient-blocklist` where policies are available. That would be an only-tighten write, but the OTP step makes it human-confirmed rather than automatic.

## 2. `dolepee/arc-mirror-kit` (the "Shadow" project): nearest prior art on Arc

It's an MIT starter kit for policy-controlled USDC copy trading. Its four primitives:

| Primitive | What it does |
| --- | --- |
| `MirrorRouter` | A source agent publishes one intent; each follower's policy decides whether it is `COPIED` or `BLOCKED`, emitted as a `MirrorReceipt` event. One follower cannot revert the batch for the others. |
| `RiskPolicy` (library) | `maxAmountPerIntent`, `dailyCap`, `allowedAsset`, `maxRiskLevel`, with typed block reasons (`AMOUNT_TOO_HIGH`, `DAILY_CAP_EXCEEDED`, `RISK_TOO_HIGH`, …). |
| `SourceRegistry` | Agent identity, metadata URI, a reputation score and optional ERC-8004 reference fields. |
| `PilotAttestor` | Anchors a decision hash (`decisionHash, totalUSDC, confidenceBps, modelHash`) on-chain before capital moves. |

How it differs from Horos:

| | arc-mirror-kit | Horos |
| --- | --- | --- |
| What is judged | The *source agent's intent* (copy trading) | The *counterparty* being paid |
| Where risk comes from | `riskLevel` is supplied by the source agent itself | Hard rules (OFAC exact match) plus graded model judgment, re-screened by Continuous Watch |
| Who sets the limit | The follower sets their own policy, freely up or down | Rules set the ceiling, the model role can only lower it, and only the human role raises it |
| Limit shape | Per-intent max plus daily cap | Cumulative per counterparty per policy period (per-payment maxes are defeated by splitting) |
| Evidence | Decision hash, receipts as events | Per-decision evidence record |

Ideas worth borrowing (proposals, not decisions):

- **Typed reason codes in events.** `MirrorReceipt` carries an enum reason so indexers and dashboards never have to infer outcomes from token transfers. Check that PolicyWallet's events do the same.
- **The "no cascade" property.** One failing item never reverts a batch. Relevant if Continuous Watch ever writes limits in batches.
- **Attest-then-execute.** `PilotAttestor` is a small on-chain decision-hash anchor, close to the "Arc-anchored evidence" stretch goal.

## 3. Arc's compliance vendor page

`docs.arc.io/arc/tools/compliance-vendors` lists three providers: Chainalysis, Elliptic and TRM Labs. All three offer screening, scoring and monitoring. None offers an on-chain enforcement layer an agent cannot exceed. This matches the existing market research, which describes their output as alerts for human analysts. They remain candidates as optional evidence sources, not competitors to the enforcement layer.

## 4. The `arc-canteen` CLI

- Install with `uv tool install arc-canteen` (it's on PyPI now, so the git URL isn't needed).
- Useful commands beyond `rpc` and `wallet`:
  - `context sync` pulls the docs bundle: an Arc docs mirror, a Circle docs mirror with OpenAPI specs, the Circle `SKILL.md` files, and 8 `circlefin/*` sample apps as submodules.
  - `submit-showcase` submits a project to the Arc Showcase (criteria at https://arc-oss.thecanteenapp.com/).
  - `update-traction` and `update-product` report progress to Canteen.
- The login gives a testnet wallet funded with $5 of USDC. Its private key lives only in `~/.arc-canteen/wallet.yaml`. Use it for test agents only, never for deployed services.
- **RPC caveat:** the Canteen RPC token is per user, and a login on another machine invalidates older tokens (`rotate-rpc-key` fixes the 401). The RPC proxy also allows only a fixed list of methods, mostly reads plus `eth_sendRawTransaction`. Horos services and tests use the public endpoints (`rpc.testnet.arc.io`, `rpc.testnet.arc.network`), which avoids both problems. Keep it that way.

## 5. Other docs in the bundle worth reading at build time

- `docs.arc.network/arc/tutorials/monitor-contract-events.md`: event monitoring, for Continuous Watch and the outbox worker.
- `docs.arc.network/build/agentic-economy.md`, `register-your-first-ai-agent.md` (ERC-8004) and `create-your-first-erc-8183-job.md`: on-chain agent identity and reputation, a possible counterparty signal.
- `docs/circlefin-skills/*.md`: Circle's `SKILL.md` format. A reference for the Horos Claude Code skill.
- `the-canteen-dev/circle-agent`: an x402 batched-payment demo, a reference for the pay-per-check endpoint.
- `Bagwork-fun/arc-plugins`: App Kit plugins for the Eliza, OpenClaw and Hermes agent frameworks. A pattern for distributing Horos beyond MCP.
