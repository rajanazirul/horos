# Market research notes (2026-09-24)

Raw findings collected while writing the innovation strategy (an internal planning document). Treat as a snapshot; verify before relying on any figure.

## Tameion Agents Hackathon
- Host Canteen, with Circle and Arc. Online, invite-only, **Sep 27 – Oct 10, 2026**; submissions close **Oct 10, 11:59 PM ET**.
- Judging: Agentic sophistication 30% · Traction 30% · Circle tool usage 20% · Innovation 20%.
- Horos targets **RFB 05: Compliance Intelligence Agent** (continuous, risk-tiered, network-aware screening).
- Full page snapshot: `tameion-hackathon-page.md`. Required reading: https://thecanteenapp.com/analysis/2026/09/12/agents-and-ledgers.html
- Submission needs: public GitHub repo, <3 min video, optional live link, traction answers (businesses onboarded, value moved, problems solved).

## Jev (TypeSafe AI)
- Launched Sep 15, 2026 (early access). Founder Diogo Almeida (co-inventor of RLHF/InstructGPT).
- "System One" model: typed answers only (Boolean / Choice / Score) with **calibrated probabilities + confidence**; no free text, so no answers outside the defined options.
- 70–500ms end to end; 40–200× faster than LLMs on the same decisions.
- Price seen in docs: **$0.042 per 1M input tokens, $0 output** (jev-1.12, Sep 2026). May change.
- API: `POST /v1/systemone`, model `jev-latest`. Claude Code plugin: `claude plugin marketplace add typesafe-ai/skills` then `claude plugin install typesafe@typesafe-ai`.
- Design guidance: code owns the control flow and side effects; Jev answers narrow atomic questions; use confidence to act / review / escalate.
- Full docs: https://docs.typesafe.ai/llms-full.txt (early-access material; not redistributed in this repo).

## Competitive landscape
- **Circle Compliance Engine**: transaction screening, ALLOWED/DENIED, "available for eligible users". Test-address suffixes simulate risk. https://developers.circle.com/wallets/compliance-engine
- **Range** (range.org): $8.3M Series A mid-2026; enterprise stablecoin/fiat control layer; markets pre-execution controls for x402 agent payments.
- **402Sentinel**, **BlockSec x402 KYA**: pay-per-call address screening for agents (Base/Solana). Address-level only.
- **Allium**, **Intercepta**: onchain data and monitoring for payment networks and institutions.
- **Chainalysis / TRM / Elliptic**: enterprise intelligence and KYT; alerts for human analysts.
- **x402 Foundation**: draft spec `pre-payment-compliance-gate-v1` (PR #2495), still open.

## Not yet verified (the search hit a rate limit)
- Chainalysis free sanctions screening API / oracle: terms and coverage.
- GENIUS Act (US stablecoin law): what it requires of businesses that pay in USDC.
- OpenSanctions licence: believed CC BY-NC (commercial use needs a licence). Confirm.
- Circle Compliance Engine eligibility for a solo, non-US founder on the Arc testnet.
