import { Reveal } from "./Reveal";

const TIERS = [
  {
    name: "Open source",
    price: "Free",
    unit: "self-hosted",
    body: "The parts you should be able to audit and run yourself.",
    items: [
      "Hard rules in code",
      "OFAC SDN exact-match screening",
      "The on-chain policy contract",
      "Self-host on your own infrastructure",
    ],
    status: null,
  },
  {
    name: "Hosted screening",
    price: "$0.50–$2",
    unit: "per counterparty per month",
    body: "Your first 25 counterparties are free.",
    items: [
      "Everything in open source",
      "Graded judgment with calibrated confidence",
      "Daily re-screening, plus a re-screen when sanctions lists change",
      "Automatic on-chain tightening",
      "Signed evidence record for every decision",
    ],
    status: null,
  },
  {
    name: "Pay per check",
    price: "$0.001–$0.01",
    unit: "per check, paid over x402",
    body: "For agents calling Horos directly. No account needed.",
    items: ["One graded check per call", "Paid in USDC per request"],
    status: "Coming soon",
  },
];

export function Pricing() {
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <Reveal className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <h2
              id="pricing-title"
              className="font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl"
            >
              Planned pricing
            </h2>
            <p className="mt-5 text-lg leading-8 text-muted">
              Pay per counterparty you watch, not per seat and not a cut of the money you move.
            </p>
          </div>
          <p className="max-w-xs rounded-md border border-cap/50 px-4 py-3 text-sm leading-6 text-ink">
            Early access is free during Tameion. These prices are planned and may change before
            anything is billed.
          </p>
        </Reveal>

        <Reveal as="ul" delay={100} className="mt-12 grid border-y border-line md:grid-cols-3">
          {TIERS.map((t, i) => (
            <li
              key={t.name}
              className={`py-8 md:px-8 md:py-10 ${i > 0 ? "border-t border-line md:border-l md:border-t-0" : ""} ${i === 0 ? "md:pl-0" : ""} ${i === TIERS.length - 1 ? "md:pr-0" : ""}`}
            >
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-medium text-ink">{t.name}</h3>
                {t.status ? (
                  <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted">
                    {t.status}
                  </span>
                ) : null}
              </div>
              <p className="mt-4 font-display text-4xl font-medium tracking-tight text-ink">
                {t.price}
              </p>
              <p className="mt-1 text-sm text-muted">{t.unit}</p>
              <p className="mt-4 text-[0.9375rem] leading-7 text-ink">{t.body}</p>
              <ul className="mt-5 space-y-2.5">
                {t.items.map((it) => (
                  <li key={it} className="flex gap-3 text-[0.9375rem] leading-6 text-muted">
                    <span className="mt-[0.7rem] h-px w-3 shrink-0 bg-line-strong" aria-hidden="true" />
                    {it}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
