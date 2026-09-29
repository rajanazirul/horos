type Decision = "allow" | "cap" | "hold" | "block";

export type AmountRow = {
  situation: string;
  decision: Decision;
  /** Amount the agent asked to pay, in USDC. */
  requested: number;
  /** Amount that actually left the wallet. `null` = pending a person's review. */
  paid: number | null;
};

type Props = {
  rows: AmountRow[];
  /** Name of the example scenario, used in the accessible label. */
  label: string;
};

const barColor: Record<Decision, string> = {
  allow: "bg-allow",
  cap: "bg-cap",
  hold: "bg-hold",
  block: "bg-block",
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });

/**
 * "Requested vs paid" bar pairs, one pair per example check. Each pair is scaled
 * to its own request, so the paid bar reads as the share that left the wallet.
 * Rows are keyed by position so the paid width animates when the tab changes.
 */
export function AmountBars({ rows, label }: Props) {
  return (
    <figure className="m-0">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium text-ink">Requested vs paid</span>
        <span className="text-xs text-muted">Each pair is scaled to its own request.</span>
      </figcaption>
      <ul className="mt-4 space-y-4" aria-label={`Requested and paid amounts for ${label}`}>
        {rows.map((r, i) => {
          const pending = r.paid === null;
          const paid = r.paid ?? 0;
          const share = r.requested > 0 ? Math.min(1, paid / r.requested) : 0;
          const paidText = pending ? "pending" : fmt(paid);
          return (
            // Index key on purpose: the same DOM bars persist across tabs, so widths transition.
            <li key={i}>
              <p className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 text-ink">{r.situation}</span>
                <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-2 w-2 rounded-full transition-colors duration-500 ${barColor[r.decision]}`}
                  />
                  {r.decision}
                </span>
              </p>
              <span className="sr-only">
                {`Requested ${fmt(r.requested)} USDC, ${pending ? "payment pending review" : `paid ${paidText} USDC`}.`}
              </span>
              <div
                aria-hidden="true"
                className="mt-1.5 grid grid-cols-[4.25rem_minmax(0,1fr)_4.5rem] items-center gap-x-2 gap-y-1 font-mono text-[11px] tabular-nums text-muted"
              >
                <span>requested</span>
                <span className="block h-2 border-l border-line-strong">
                  <span className="block h-2 w-full rounded-r-[4px] bg-muted/55" />
                </span>
                <span className="text-right text-ink">{fmt(r.requested)}</span>

                <span>paid</span>
                <span className="block h-2 border-l border-line-strong">
                  <span
                    className={`block h-2 rounded-r-[4px] transition-[width,background-color] duration-500 ease-out ${
                      pending
                        ? "bg-[repeating-linear-gradient(135deg,var(--hold)_0_2px,transparent_2px_5px)]"
                        : barColor[r.decision]
                    }`}
                    style={{ width: `${(pending ? 1 : share) * 100}%` }}
                  />
                </span>
                <span className="text-right text-ink">{paidText}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
