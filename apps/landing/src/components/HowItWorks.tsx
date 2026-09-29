import type { CSSProperties } from "react";
import { CalibrationPlot } from "./charts/CalibrationPlot";
import { PipelineDiagram } from "./PipelineDiagram";
import { Reveal } from "./Reveal";

const STEPS = [
  {
    title: "Hard rules",
    who: "Deterministic code",
    body: "An exact match on the OFAC SDN list always blocks. No probability involved. An optional Circle Compliance Engine verdict and your own caps apply here too. Together they set the ceiling.",
  },
  {
    title: "Graded judgment",
    who: "Jev by TypeSafe AI",
    body: "The fuzzy questions go to Jev as typed questions: is this near-miss name really the listed entity? Is this a high-risk industry? Answers come back as calibrated probabilities in about 100ms.",
  },
  {
    title: "Policy",
    who: "Your policy",
    body: "Conservative, standard or permissive. Your policy turns grades and confidence into a decision. Low-confidence answers go to a person instead of guessing.",
  },
  {
    title: "On-chain limit",
    who: "Smart contract on Arc",
    body: "Horos writes the counterparty's limit to your policy contract. Your agent's wallet cannot send more than that, whatever its prompt says.",
  },
  {
    title: "Evidence record",
    who: "Signed log",
    body: "Every decision is saved as a signed record: inputs, sources, probabilities, the rule applied and the action taken. It answers \"why did the agent pay that?\"",
  },
];

const DECISIONS = [
  { name: "allow", color: "bg-allow", text: "Pay up to the counterparty's limit." },
  { name: "cap", color: "bg-cap", text: "Pay, but only up to a lower limit." },
  { name: "hold", color: "bg-hold", text: "Wait for a person to approve." },
  { name: "block", color: "bg-block", text: "Don't pay. Hard-rule matches land here." },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <Reveal className="max-w-2xl">
          <h2
            id="how-title"
            className="font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl"
          >
            One call runs five steps, and each has a single job.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted">
            Rules that must never bend stay in code. Judgment that needs nuance goes to a model
            built to return numbers, not prose. The result is enforced where the money moves.
          </p>
        </Reveal>

        <PipelineDiagram>
          <ol className="relative grid gap-0 lg:grid-cols-5 lg:gap-10">
            {STEPS.map((s, i) => (
              <li
                key={s.title}
                className="relative border-l border-line pb-10 pl-7 last:pb-0 lg:border-l-0 lg:pb-0 lg:pl-0"
              >
                <span
                  aria-hidden="true"
                  className="absolute -left-[0.55rem] top-0 z-10 flex h-[1.1rem] w-[1.1rem] items-center justify-center rounded-full border border-line-strong bg-bg lg:hidden"
                >
                  <span
                    className="pd-dot h-1.5 w-1.5 rounded-full bg-accent"
                    style={{ "--draw-delay": `${i * 400}ms` } as CSSProperties}
                  />
                </span>
                <div className="relative lg:mt-0">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-sm text-muted" aria-hidden="true">
                      {i + 1}
                    </span>
                    <h3 className="text-lg font-medium text-ink">
                      <span className="sr-only">Step {i + 1}: </span>
                      {s.title}
                    </h3>
                  </div>
                  <p className="mt-1 text-sm text-accent">{s.who}</p>
                  <p className="mt-3 text-[0.9375rem] leading-7 text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </PipelineDiagram>

        <Reveal className="mt-16 rounded-md border border-line bg-surface p-6 sm:p-8">
          <h3 className="text-base font-medium text-ink">Four possible answers</h3>
          <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {DECISIONS.map((d) => (
              <div key={d.name} className="flex gap-3">
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm ${d.color}`} aria-hidden="true" />
                <div>
                  <dt className="font-mono text-sm text-ink">{d.name}</dt>
                  <dd className="mt-1 text-sm leading-6 text-muted">{d.text}</dd>
                </div>
              </div>
            ))}
          </dl>
          <p className="mt-6 border-t border-line pt-5 text-sm leading-6 text-muted">
            Every answer carries a plain-language reason and a confidence between 0 and 1, so your
            agent, and anyone reviewing it later, can see why.
          </p>
        </Reveal>

        <Reveal className="mt-16 grid items-center gap-10 lg:grid-cols-[1fr_auto] lg:gap-16">
          <div className="max-w-xl">
            <h3 className="font-display text-2xl font-medium leading-snug text-ink sm:text-3xl">
              A confidence of 0.9 should be right about nine times in ten.
            </h3>
            <p className="mt-4 leading-7 text-muted">
              That is what calibrated means, and it is what lets your policy trust a high-confidence
              answer and send a low-confidence one to a person. We plan to measure it on real traffic
              and publish the curve, including where it misses.
            </p>
          </div>
          <CalibrationPlot className="lg:w-[420px]" />
        </Reveal>
      </div>
    </section>
  );
}
