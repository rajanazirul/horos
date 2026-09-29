"use client";

import { Reveal } from "./Reveal";
import { useRef, useState } from "react";
import { AmountBars } from "./charts/AmountBars";

type Decision = "allow" | "cap" | "hold" | "block";

type UseCase = {
  id: string;
  label: string;
  who: string;
  problem: string;
  horos: string;
  checks: {
    situation: string;
    /** Display string (keeps the existing formatting). */
    amount: string;
    decision: Decision;
    result: string;
    /** Numeric twins for the chart, in USDC. `paid: null` = pending review. */
    requested: number;
    paid: number | null;
  }[];
};

const CASES: UseCase[] = [
  {
    id: "ap",
    label: "Contractor payouts",
    who: "A US agency whose accounts-payable agent pays about 120 freelancers worldwide in USDC.",
    problem:
      "The founder won't let the agent pay without a human checking every invoice. One sanctioned wallet is a strict-liability problem, whatever the agent was told.",
    horos:
      "The agent calls check() before every payout. Known freelancers are paid right away. New or unusual payees get a lower limit until someone on the team signs off.",
    checks: [
      { situation: "Known freelancer, clean history", amount: "2,400", requested: 2400, decision: "allow", paid: 2400, result: "paid in full" },
      { situation: "New payee, first invoice", amount: "9,000", requested: 9000, decision: "cap", paid: 1500, result: "limit 1,500 until approved" },
      { situation: "Near-miss name, high-risk region", amount: "3,000", requested: 3000, decision: "hold", paid: null, result: "waits for review" },
      { situation: "Wallet on a sanctions list", amount: "500", requested: 500, decision: "block", paid: 0, result: "hard rule, never paid" },
    ],
  },
  {
    id: "x402",
    label: "Pay-per-call APIs",
    who: "A data API that charges AI agents per request over x402.",
    problem:
      "Thousands of unknown agent wallets pay it every day. Nobody can review them one by one, and taking money from a sanctioned wallet is a problem too.",
    horos:
      "Every new payer wallet is screened and given a limit. The daily re-screen keeps going after that, so a wallet that turns risky next month is refused on its next request.",
    checks: [
      { situation: "Returning agent wallet", amount: "0.002", requested: 0.002, decision: "allow", paid: 0.002, result: "request served" },
      { situation: "Brand-new wallet, burst of calls", amount: "40", requested: 40, decision: "cap", paid: 5, result: "limit 5 per day" },
      { situation: "Funds traced to a flagged address", amount: "0.002", requested: 0.002, decision: "hold", paid: null, result: "paused, evidence logged" },
      { situation: "Sanctioned address", amount: "0.002", requested: 0.002, decision: "block", paid: 0, result: "refused" },
    ],
  },
  {
    id: "treasury",
    label: "Vendor treasury",
    who: "A SaaS startup that holds operating cash in USDC and lets a treasury agent pay about 30 vendors.",
    problem:
      "Vendors were screened once, at onboarding. If one becomes risky six months later, nothing looks again and the scheduled payments keep going out.",
    horos:
      "Horos re-screens every vendor daily and whenever the lists change. When a vendor's risk changes, its on-chain limit drops before the next payment runs.",
    checks: [
      { situation: "Hosting provider, monthly bill", amount: "4,200", requested: 4200, decision: "allow", paid: 4200, result: "paid on schedule" },
      { situation: "Vendor near-matches a new listing", amount: "12,000", requested: 12000, decision: "cap", paid: 250, result: "limit cut to 250" },
      { situation: "Vendor exactly matches a new listing", amount: "12,000", requested: 12000, decision: "block", paid: 0, result: "limit set to 0" },
    ],
  },
  {
    id: "marketplace",
    label: "Marketplace payouts",
    who: "A creator or seller marketplace that pays out weekly in USDC to a global seller base.",
    problem:
      "New accounts try to cash out stolen balances, and some sellers sit in high-risk jurisdictions. A flat payout rule is either too loose or blocks good sellers.",
    horos:
      "Limits grow with a seller's track record. Graded signals can only lower a limit. Only a person on the platform's ops team can raise one.",
    checks: [
      { situation: "Established seller", amount: "6,500", requested: 6500, decision: "allow", paid: 6500, result: "weekly payout sent" },
      { situation: "Account opened this week", amount: "3,000", requested: 3000, decision: "cap", paid: 300, result: "limit 300 for now" },
      { situation: "Payout wallet shared by many accounts", amount: "1,800", requested: 1800, decision: "hold", paid: null, result: "ops reviews it" },
    ],
  },
  {
    id: "b2b",
    label: "Cross-border suppliers",
    who: "A US importer that pays overseas manufacturers in USDC because it settles faster than a wire.",
    problem:
      "Suppliers are in higher-risk corridors, and a supplier's own counterparties are hard to see. A yes-or-no check can't size a first order.",
    horos:
      "A first large order is capped, with the reason and a confidence score attached. The rest is released once someone on the importer's team has looked.",
    checks: [
      { situation: "Long-standing supplier", amount: "40,000", requested: 40000, decision: "allow", paid: 40000, result: "paid in full" },
      { situation: "New supplier, first order", amount: "80,000", requested: 80000, decision: "cap", paid: 20000, result: "limit 20,000 until reviewed" },
      { situation: "Model not confident", amount: "15,000", requested: 15000, decision: "hold", paid: null, result: "waits for review" },
    ],
  },
];

// The check list sits on the always-dark code background, so it uses the
// theme-independent code palette rather than the text-allow/cap/... tokens.
const decisionColor: Record<Decision, string> = {
  allow: "text-[var(--code-allow)]",
  cap: "text-[var(--code-cap)]",
  hold: "text-[var(--code-hold)]",
  block: "text-[var(--code-block)]",
};

export function UseCases() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const c = CASES[active];

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % CASES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + CASES.length) % CASES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = CASES.length - 1;
    else return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <section id="use-cases" aria-labelledby="cases-title" className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <Reveal className="max-w-2xl">
          <h2
            id="cases-title"
            className="font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl"
          >
            Wherever an agent pays counterparties that change.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted">
            The same check works across very different businesses. Your policy decides what each
            answer means; Horos enforces it and keeps the evidence.
          </p>
        </Reveal>

        <Reveal delay={100} className="mt-12 grid gap-8 lg:grid-cols-[16rem_1fr] lg:gap-12">
          <div
            role="tablist"
            aria-label="Example use cases"
            aria-orientation="vertical"
            className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:self-start lg:overflow-visible lg:border-l lg:border-line lg:pb-0"
          >
            {CASES.map((u, i) => {
              const isActive = i === active;
              return (
                <button
                  key={u.id}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`case-tab-${u.id}`}
                  aria-selected={isActive}
                  aria-controls={`case-panel-${u.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActive(i)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  className={`shrink-0 whitespace-nowrap rounded-md border px-3.5 py-2 text-left text-sm transition-colors lg:-ml-px lg:rounded-none lg:rounded-r-md lg:border-0 lg:border-l-2 lg:px-5 lg:py-3 ${
                    isActive
                      ? "border-accent bg-surface text-ink"
                      : "border-line text-muted hover:bg-surface/60 hover:text-ink lg:border-transparent"
                  }`}
                >
                  {u.label}
                </button>
              );
            })}
          </div>

          <div
            role="tabpanel"
            id={`case-panel-${c.id}`}
            aria-labelledby={`case-tab-${c.id}`}
            className="rounded-md border border-line bg-surface p-5 sm:p-7"
          >
            <dl className="grid gap-6 md:grid-cols-3 md:gap-8">
              {[
                ["Who", c.who],
                ["The problem", c.problem],
                ["With Horos", c.horos],
              ].map(([term, body]) => (
                <div key={term}>
                  <dt className="text-sm font-medium text-ink">{term}</dt>
                  <dd className="mt-2 text-[0.9375rem] leading-7 text-muted">{body}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-8 border-t border-line pt-6">
              <AmountBars rows={c.checks} label={c.label} />
            </div>

            <ul className="mt-8 space-y-3 rounded-sm bg-code-bg p-4 font-mono text-xs leading-6 text-code-ink sm:hidden">
              {c.checks.map((k) => (
                <li key={k.situation}>
                  <p>{k.situation}</p>
                  <p className="text-[var(--code-muted)]">
                    {k.amount} → <span className={decisionColor[k.decision]}>{k.decision}</span>
                    <span className="text-code-ink"> · {k.result}</span>
                  </p>
                </li>
              ))}
            </ul>

            <div className="mt-8 hidden overflow-x-auto rounded-sm bg-code-bg p-4 font-mono text-xs leading-6 text-code-ink sm:block">
              <table className="w-full min-w-[34rem] border-collapse text-left">
                <caption className="sr-only">Example checks for {c.label}</caption>
                <thead>
                  <tr className="text-[var(--code-muted)]">
                    <th scope="col" className="pb-2 pr-4 font-normal">situation</th>
                    <th scope="col" className="pb-2 pr-4 text-right font-normal">amount</th>
                    <th scope="col" className="pb-2 pr-4 font-normal">decision</th>
                    <th scope="col" className="pb-2 font-normal">result</th>
                  </tr>
                </thead>
                <tbody>
                  {c.checks.map((k) => (
                    <tr key={k.situation}>
                      <td className="pr-4">{k.situation}</td>
                      <td className="pr-4 text-right tabular-nums">{k.amount}</td>
                      <td className={`pr-4 ${decisionColor[k.decision]}`}>{k.decision}</td>
                      <td>{k.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs leading-5 text-muted">
              Example scenario, not a customer. Amounts in USDC. Limits come from the policy you set.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
