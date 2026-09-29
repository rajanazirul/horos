import Image from "next/image";
import { Reveal } from "./Reveal";

const PROBLEMS = [
  {
    title: "Checked once, then forgotten",
    body: "Screening runs when a counterparty is added or a payment goes out. If that vendor becomes risky next week, nothing looks again, and your agent keeps paying.",
  },
  {
    title: "Yes or no, with nothing between",
    body: "A binary check either blocks a real supplier over a near-miss name or waves everything through. An agent needs a graded answer it can act on: pay less, wait, or stop.",
  },
  {
    title: "Guardrails in prompts can be talked past",
    body: "\"Never pay a sanctioned wallet\" in a system prompt is a request, not a control. One injected instruction in an invoice or a webpage and the agent can argue itself out of it.",
  },
];

export function Problem() {
  return (
    <section aria-labelledby="problem-title" className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <h2
          id="problem-title"
          className="max-w-2xl font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl"
        >
          Counterparty screening was built for people checking once. Agents pay all day.
        </h2>
        <Reveal as="figure" className="relative mt-10 aspect-[16/7] overflow-hidden rounded-md border border-line bg-code-bg sm:aspect-[21/7]">
          <Image
            src="/images/stream.webp"
            alt=""
            fill
            sizes="(max-width: 1152px) 100vw, 1152px"
            className="object-cover object-left"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-code-bg/70"
          />
          <figcaption className="absolute bottom-3 right-4 max-w-[16rem] text-right font-mono text-[11px] leading-4 text-code-ink sm:bottom-5 sm:right-6 sm:text-xs">
            Payments keep flowing. The line has to hold every time, not just the first.
          </figcaption>
        </Reveal>
        <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
          {PROBLEMS.map((p, i) => (
            <Reveal key={p.title} delay={i * 120}>
              <div className="limit-line mb-5 w-10" aria-hidden="true" />
              <h3 className="text-lg font-medium text-ink">{p.title}</h3>
              <p className="mt-3 leading-7 text-muted">{p.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
