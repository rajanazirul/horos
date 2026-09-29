# Horos

The only-tighten safety layer for AI agents that pay in USDC. Built for RFB 05 (Compliance Intelligence) of the **Tameion Agents Hackathon** (Canteen × Circle × Arc, **Sep 27 – Oct 10, 2026**; submit by Oct 10, 11:59 PM ET).

One call, `check(counterparty, amount)`, returns **allow / cap / hold / block** with a reason and a calibrated confidence, and writes a per-counterparty spending limit to an Arc smart contract that the agent cannot exceed.

## Source of truth
- The PRD and the architecture spine (**AD-1 to AD-25**) are internal planning documents kept outside this repository. `AD-n` citations in code, tests and docs refer to the spine, which is binding for all build work; the summary under "Architecture (planned)" below is subordinate to it.
- **Research:** `docs/research/` (market notes, Tameion page snapshot, stack considerations).
- Founder and planning context for the maintainer's own sessions lives in `CLAUDE.local.md`, which is not part of this repository.

## Architecture (planned)
Summary only; the architecture spine is authoritative (dedicated PolicyWallet contract, hexagonal core, worker outbox, Railway + Postgres, Circle EOAs, no Gas Station).
1. **Hard rules in code** (exact OFAC SDN match → block; Circle Compliance Engine not used in v1). Deterministic, never probabilistic.
2. **Graded judgment by Jev**: atomic Boolean/Choice/Score questions (near-miss names, high-risk industry, unusual flows, second-degree exposure). Behind a **model-agnostic interface, no fallback**: if Jev fails, `check()` returns an error and writes nothing.
3. **Policy** → decision.
4. **RiskTier PolicyWallet** (Arc contract): per-counterparty limits. Roles: rules set the ceiling, the model role can only lower it, only a human role raises it.
5. **Continuous Watch**: daily re-screen plus a trigger on OFAC list updates.
6. **Evidence record** per decision.
7. Distribution: TypeScript SDK, **MCP server and Claude Code skill**, and an x402 pay-per-check endpoint (later).

## Non-negotiable rules
- **Safety invariant: the model can only tighten.** Nothing probabilistic may raise a limit or override a hard-rule block. Cover it with invariant tests (Foundry) in the contract.
- **Non-custodial.** The customer's wallet and the customer's keys; Horos never holds funds. This avoids US money-transmitter licensing.
- **Positioning:** a policy-enforcement and evidence tool. Never claim "we make you compliant"; the customer stays the compliance decision-maker.
- **No fabricated traction, testimonials, customers or logos.** No Circle/Arc/TypeSafe/OFAC brand assets, and no implied partnership. Keep a traction ledger that separates own test wallets / other teams' test usage / real businesses.
- **Network data sharing** across customers needs legal review first (FCRA, antitrust). Opt-in, business entities only, derived signals only.
- Counterparties never pay to improve their standing.

## Repo layout
The Layout table in `README.md` is the current map of workspaces.
- `apps/landing`: Next.js 16 sales page (App Router, TypeScript, Tailwind v4, static export). See `apps/landing/README.md` and `PROGRESS.md`.
  - Placeholders to fill: `grep -rn "TODO(founder)" apps/landing/src` (GitHub URL, early-access email, npm package names, `NEXT_PUBLIC_SITE_URL`, illustrative Solidity excerpt).
- `docs/`: research notes and the Railway deploy runbook.

## Tooling
- ARC CLI: `uv tool install git+https://github.com/the-canteen-dev/ARC-cli` (Canteen-hosted Arc testnet RPC plus Arc docs as agent context).
- Circle CLI: `npm install -g @circle-fin/cli` (Node ≥ 20.18.2).
- TypeSafe skill: `claude plugin marketplace add typesafe-ai/skills` then `claude plugin install typesafe@typesafe-ai`.
- Reference sample apps: circlefin/arc-escrow, arc-x402-circle-wallets, arc-fintech, arc-multichain-wallet.
