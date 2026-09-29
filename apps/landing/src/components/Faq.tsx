import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Does Horos hold my money or my keys?",
    a: "No. Horos is non-custodial. Payments go from your wallet, signed with your keys. Horos returns decisions and writes limits to a policy contract your wallet is bound by. It never holds or moves funds.",
  },
  {
    q: "What happens when the model gets it wrong?",
    a: "Your agent pays less, not more. The model can only lower a limit below the ceiling that hard rules and your policy set. It can never raise one, and it never overrides an exact sanctions match. When the model isn't confident, the default is to hold the payment for a person. Every decision carries its reason and evidence, so a wrong call is easy to spot and a person can raise the limit.",
  },
  {
    q: "Can a prompt injection talk the agent past a limit?",
    a: "No. The limit lives in a smart contract, not in the agent's prompt. Even if an injected instruction convinces the agent's LLM to try, the wallet can't send more than the contract allows.",
  },
  {
    q: "Is this compliance advice? Will it make me compliant?",
    a: "No, and no. Horos is a policy-enforcement and evidence tool. It enforces the policy you choose and records why each decision was made. You stay the compliance decision-maker, and you should get your own legal advice.",
  },
  {
    q: "Which chains does it support?",
    a: "Arc first, and today only on Arc testnet. Screening is designed to be chain-agnostic, and support for other EVM chains is planned.",
  },
  {
    q: "Where do the judgments come from?",
    a: "Hard rules are plain code: an exact match against the OFAC SDN list, plus an optional Circle Compliance Engine verdict. Graded judgments come from Jev by TypeSafe AI, a model that answers typed questions with calibrated probabilities instead of generating text.",
  },
  {
    q: "What if a counterparty thinks it was downgraded unfairly?",
    a: "Every downgrade has a recorded reason, and a person on your side can raise the limit. A way for counterparties to see their standing and appeal is coming soon.",
  },
  {
    q: "Does it look at my vendor's vendors?",
    a: "Not yet. Second-degree exposure, where a counterparty's own payment partners count toward its risk, is coming soon.",
  },
];

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="border-t border-line bg-surface/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:py-24">
        <h2
          id="faq-title"
          className="font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl"
        >
          Questions developers ask first
        </h2>
        <Reveal delay={100} className="border-t border-line">
          {FAQS.map((f) => (
            <details key={f.q} className="group border-b border-line">
              <summary className="flex cursor-pointer items-start justify-between gap-6 py-5 text-left text-ink">
                <span className="text-[1.0625rem] font-medium leading-7">{f.q}</span>
                <span
                  aria-hidden="true"
                  className="faq-mark mt-1 flex h-5 w-5 shrink-0 items-center justify-center text-muted transition-transform"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </span>
              </summary>
              <div className="max-w-2xl pb-6 leading-7 text-muted">{f.a}</div>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
