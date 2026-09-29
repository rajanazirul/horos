"use client";

import { Reveal } from "./Reveal";
import { useEffect, useRef, useState } from "react";
import { LimitTimelineChart } from "./charts/LimitTimelineChart";

type Step = {
  time: string;
  /** Minutes since Mon 09:00, for the limit timeline chart. */
  minute: number;
  title: string;
  body: string;
  limit: number;
  decision: "allow" | "cap" | "hold" | "block" | "checking";
  log: string;
  /** Payment the agent attempted at this step, in USDC. */
  amount?: number;
  listUpdate?: boolean;
};

const STEPS: Step[] = [
  {
    time: "Mon 09:00",
    minute: 0,
    amount: 1800,
    title: "Your agent pays a regular vendor",
    body: "Example Vendor Co. is clean on every check. Standard policy, limit 5,000 USDC. The invoice goes through.",
    limit: 5000,
    decision: "allow",
    log: "check  vendor=0x4b1e…9a07  amount=1,800  → allow  limit=5,000",
  },
  {
    time: "Tue 02:10",
    minute: 1030,
    listUpdate: true,
    title: "A sanctions list update is published",
    body: "Horos re-screens every counterparty daily, and again whenever the lists change. Nobody has to remember to look.",
    limit: 5000,
    decision: "checking",
    log: "watch  sdn-list updated  → re-screening every counterparty",
  },
  {
    time: "Tue 02:11",
    minute: 1031,
    title: "The vendor's risk changes, and the limit tightens",
    body: "The vendor's registered name now closely matches a newly listed entity. Not an exact match, so Jev grades it: medium risk, confidence 0.88. Your policy says cap. Horos lowers the limit on-chain to 250.",
    limit: 250,
    decision: "cap",
    log: "tighten vendor=0x4b1e…9a07  5,000 → 250  reason=near-name-match  conf=0.88",
  },
  {
    time: "Tue 09:30",
    minute: 1470,
    amount: 1200,
    title: "The next payment is capped",
    body: "The agent tries to pay a 1,200 USDC invoice. The contract won't let more than 250 leave the wallet, whatever the agent was told. The invoice waits for you, with the evidence attached.",
    limit: 250,
    decision: "cap",
    log: "check  vendor=0x4b1e…9a07  amount=1,200  → cap  limit=250  evidence=ev_…7KD",
  },
];

const MAX_LIMIT = 5000;

const decisionStyle: Record<Step["decision"], string> = {
  allow: "text-allow",
  cap: "text-cap",
  hold: "text-hold",
  block: "text-block",
  checking: "text-muted",
};

export function ContinuousWatch() {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!playing) return;
    timer.current = setTimeout(() => {
      const next = Math.min(active + 1, STEPS.length - 1);
      setActive(next);
      if (next >= STEPS.length - 1) setPlaying(false);
    }, 2200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [playing, active]);

  const step = STEPS[active];
  const atEnd = active === STEPS.length - 1;

  return (
    <section id="continuous" aria-labelledby="watch-title" className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <Reveal className="max-w-2xl">
          <h2
            id="watch-title"
            className="font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl"
          >
            It keeps watching after the first payment.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted">
            A counterparty that was fine on Monday can be a problem by Tuesday. Horos re-checks,
            tightens the limit on-chain, and your agent&apos;s next payment respects it.
          </p>
        </Reveal>

        <Reveal delay={100} className="mt-12 grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:gap-12">
          <ol className="border-l border-line">
            {STEPS.map((s, i) => {
              const isActive = i === active;
              const isPast = i < active;
              return (
                <li key={s.time} className="relative">
                  <span
                    aria-hidden="true"
                    className={`absolute -left-[5px] top-5 h-2.5 w-2.5 rounded-full border transition-colors ${
                      isActive
                        ? "border-accent bg-accent"
                        : isPast
                          ? "border-line-strong bg-line-strong"
                          : "border-line-strong bg-bg"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(false);
                      setActive(i);
                    }}
                    aria-current={isActive ? "step" : undefined}
                    className={`w-full rounded-r-md py-3.5 pl-6 pr-3 text-left transition-colors ${
                      isActive ? "bg-surface" : "hover:bg-surface/60"
                    }`}
                  >
                    <span className="block font-mono text-xs text-muted">{s.time}</span>
                    <span className={`mt-1 block font-medium ${isActive ? "text-ink" : "text-muted"}`}>
                      {s.title}
                    </span>
                    {isActive ? (
                      <span className="mt-2 block text-[0.9375rem] leading-7 text-muted">{s.body}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-col rounded-md border border-line bg-surface p-5 sm:p-7">
            <div aria-live="polite" className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm text-muted">On-chain limit for Example Vendor Co.</p>
                <p className="mt-1 font-display text-5xl font-medium tabular-nums text-ink">
                  {step.limit.toLocaleString("en-US")}
                  <span className="ml-2 font-sans text-base font-normal text-muted">USDC</span>
                </p>
              </div>
              <p className={`font-mono text-sm ${decisionStyle[step.decision]}`}>
                {step.decision === "checking" ? "re-screening…" : step.decision}
              </p>
            </div>

            <div className="mt-6">
              <LimitTimelineChart
                steps={STEPS}
                active={active}
                maxLimit={MAX_LIMIT}
                counterparty="Example Vendor Co."
              />
            </div>

            <div className="mt-6 flex-1 rounded-sm bg-code-bg p-4 font-mono text-xs leading-6 text-code-ink">
              {STEPS.slice(0, active + 1).map((s) => (
                <p key={s.time} className="whitespace-pre-wrap break-words pl-[10ch] -indent-[10ch]">
                  <span className="text-[var(--code-muted)]">{s.time} </span>
                  {s.log}
                </p>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  if (atEnd) {
                    setActive(0);
                    setPlaying(true);
                  } else {
                    setPlaying((p) => !p);
                  }
                }}
                className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
              >
                {playing ? "Pause" : atEnd ? "Replay" : "Play scenario"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setActive((a) => Math.max(0, a - 1));
                }}
                disabled={active === 0}
                className="inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-sm text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setActive((a) => Math.min(STEPS.length - 1, a + 1));
                }}
                disabled={atEnd}
                className="inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-sm text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
            <p className="mt-4 text-xs leading-5 text-muted">
              Example scenario with a fictional vendor. Coming soon: second-degree exposure, so a
              vendor&apos;s own vendors count too.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
