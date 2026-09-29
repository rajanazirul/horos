# Stack considerations for the PRD (2026-09-24)

Input for `bmad-prd`, to use alongside the innovation strategy (an internal planning document). This is not a decision record. It lists what the PRD should settle about the stack and why each point matters. Everything here is a proposal until the PRD or the architecture accepts it.

Source: the hackathon's Stack section (`tameion-hackathon-page.md`, lines 184–263). It matched https://tameion.thecanteenapp.com/ when checked on 2026-09-24.

## Why this matters for the PRD
- **Circle tool usage is 20% of judging.** The PRD should state which Circle products each requirement uses, so the usage is deliberate and shows up in the demo.
- The strategy lists the stack in one line (§ Current Situation) but never maps it to Horos parts. This file fills that gap.

## 1. Mapping Circle and Arc tools to Horos (proposed)

| Stack item | Proposed Horos use | Proposed priority | PRD should decide |
|---|---|---|---|
| **Contracts** | Deploy and manage the RiskTier PolicyWallet | Core | Deploy with Circle Contracts, Foundry, or both (Foundry for tests, Circle Contracts for deploy and management so it counts as Circle usage)? |
| **Wallets** (developer-controlled / agent wallets) | The agent's wallet under policy; separate keys for the rules, model and human roles | Core | Wallet type; who holds each role key without breaking the **non-custodial** rule |
| **Compliance Engine** (part of Wallets) | Optional hard-rule input: DENIED → block | Core if eligible | The fallback when we aren't eligible (still **unverified**; check on day 1) |
| **USDC** on Arc | The gated payment in the demo | Core | Nothing to decide |
| **Circle CLI / x402** + **arc-nanopayments** | Pay-per-check endpoint. The price hypothesis (~$0.001–0.01) is sub-cent, which is what Nanopayments is built for. The strategy never mentions Nanopayments. | Stretch (build if G1 = 2–4 commits) | x402 vs Nanopayments; whether to follow the draft `pre-payment-compliance-gate-v1` spec |
| **Paymaster** | Customer pays gas for limit updates in USDC | Nice-to-have | Who pays gas for limit updates: Horos, the customer or the agent |
| **App Kit (Send)** | The demo agent's payment that gets capped | Demo | Nothing to decide |
| **CCTP / Gateway** | Checking counterparties on other chains | Later (Horizon 3) | Out of scope for the hackathon |
| **USYC, App Kit Swap/Bridge, EURC FX** | Not relevant | Skip | Nothing to decide |

### Sample apps worth reusing
- **arc-x402-circle-wallets**: a demo agent that pays on its own. If G1 < 2 commits, it is the starting point for our own RFB 4 operator agent.
- **arc-nanopayments**: the pattern for the x402 pay-per-check endpoint.
- **arc-escrow** (RFB 3) and **arc-fintech** (RFB 1): what likely integration targets are built from. Knowing them makes the SDK easier to drop in.
- `CLAUDE.md`'s list of reference apps leaves out arc-nanopayments and arc-x402-circle-wallets. Update it.

## 2. Parts that aren't Circle products (not in the hackathon stack list)

| Part | Role | Open question for the PRD |
|---|---|---|
| **Jev** (TypeSafe) | Graded questions (Boolean, Choice, Score) | Rate limits and pricing are **unverified**; latency budget per `check()` |
| **Claude fallback** | Used when Jev is unavailable, behind the model-agnostic interface | Which model; how its confidence is calibrated compared with Jev's |
| **OFAC SDN list** (includes crypto addresses) | Exact-match hard rule | How we ingest it; how Continuous Watch detects list updates |
| **OpenSanctions / yente** | Entity resolution, second-degree exposure | Commercial licence is **unverified**. Use public OFAC/UN/EU lists only for the hackathon? |
| **Chainalysis free sanctions API** | Optional second hard-rule source | Terms and coverage **unverified** |
| **Arc RPC** (ARC CLI, Canteen-hosted testnet) | Reads and writes on-chain | Enough for the demo, or do we need our own node or provider? |
| **Arc history / indexer** | Signals for the "unusual flows" question | Which indexer on Arc, or do we build a minimal one? |
| **Foundry** | Invariant tests: the model can only tighten | Nothing to decide (non-negotiable) |
| **MCP SDK + Claude Code skill** | Distribution | TypeScript MCP SDK; tools to expose (`check`, `explain`, `get_limit`?) |

## 3. Build choices not yet made
- Backend language and runtime (TypeScript/Node fits the SDK, the MCP server and Circle's SDKs), and where it's hosted.
- Storage for the decision log and evidence records (append-only? signed?), and the read-only log view.
- Scheduler for Continuous Watch (daily re-screen plus a trigger when OFAC updates).
- How the SDK is packaged: TypeScript first, Python later?
- Secrets and key management for the model role and human role, without Horos holding funds.
- Testnet only for the hackathon. Anything on mainnet waits for the licence and legal checks.

## 4. Constraints the stack must keep (from CLAUDE.md)
- **Only tighten:** no probabilistic part may hold a key or code path that raises a limit.
- **Non-custodial:** Horos never controls the customer's funds or keys.
- No Circle, Arc, TypeSafe or OFAC brand assets, and no claim of partnership in the product or the demo.
