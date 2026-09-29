import { useId } from "react";

/**
 * Reliability diagram explaining "calibrated confidence". Illustrative only:
 * the bins below are a hand-drawn sketch, not measured results.
 */

type Props = {
  className?: string;
};

// Illustrative bins: stated confidence → how often the answer was right.
// Gently off the diagonal (a little over-confident at the top end).
const BINS: [number, number][] = [
  [0.15, 0.18],
  [0.35, 0.34],
  [0.55, 0.51],
  [0.75, 0.69],
  [0.9, 0.82],
];

const W = 400;
const H = 300;
const M = { top: 12, right: 16, bottom: 44, left: 54 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;
const x = (v: number) => M.left + v * plotW;
const y = (v: number) => M.top + (1 - v) * plotH;

// Smooth curve through (0,0), the bins and (1, ~0.93), Catmull-Rom → cubic Bézier.
function smoothPath(points: [number, number][]) {
  const p = points.map(([a, b]) => [x(a), y(b)] as const);
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

const CURVE = smoothPath([[0.02, 0.04], ...BINS, [0.98, 0.88]]);
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function CalibrationPlot({ className = "" }: Props) {
  const uid = useId().replace(/:/g, "");
  const headingId = `cal-h-${uid}`;
  const descId = `cal-d-${uid}`;

  return (
    <figure className={`m-0 w-full max-w-[420px] rounded-md border border-line bg-surface p-5 ${className}`}>
      <h3 id={headingId} className="text-base font-medium text-ink">
        What &lsquo;calibrated confidence&rsquo; means
      </h3>
      <p className="mt-1.5 text-sm leading-6 text-muted">
        If Horos says 0.8, it should be right about 80% of the time. The closer the dots sit to
        the diagonal, the more you can trust the number.
      </p>

      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden="true">
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-px w-4 bg-line-strong" />
          perfectly calibrated
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="relative inline-block h-0.5 w-4 rounded-full bg-accent">
            <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" />
          </span>
          illustrative model
        </li>
      </ul>

      <svg
        role="img"
        aria-labelledby={`${headingId} ${descId}`}
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 block h-auto w-full"
      >
        <desc id={descId}>
          {`Illustrative reliability diagram, not measured results. X axis: stated confidence from 0 to 100%. Y axis: how often the answer was right. A diagonal marks perfect calibration. The sketch curve stays close to it: ${BINS.map(
            ([c, r]) => `stated ${pct(c)}, right ${pct(r)}`,
          ).join("; ")}.`}
        </desc>

        <g aria-hidden="true">
          {TICKS.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={W - M.right}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? "stroke-line-strong" : "stroke-line"}
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={M.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted font-mono text-[13px] tabular-nums"
              >
                {pct(t)}
              </text>
              <text
                x={x(t)}
                y={H - M.bottom + 18}
                textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"}
                className="fill-muted font-mono text-[13px] tabular-nums"
              >
                {pct(t)}
              </text>
            </g>
          ))}
          <text
            x={M.left + plotW / 2}
            y={H - 4}
            textAnchor="middle"
            className="fill-muted font-sans text-[13px]"
          >
            stated confidence →
          </text>
          <text
            transform={`translate(12 ${M.top + plotH / 2}) rotate(-90)`}
            textAnchor="middle"
            className="fill-muted font-sans text-[13px]"
          >
            how often it was right →
          </text>

          {/* Perfect calibration */}
          <line
            x1={x(0)}
            y1={y(0)}
            x2={x(1)}
            y2={y(1)}
            className="stroke-line-strong"
            strokeWidth="1.5"
          />

          {/* Illustrative model */}
          <path
            d={CURVE}
            fill="none"
            className="stroke-accent"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {BINS.map(([c, r]) => (
            <circle
              key={c}
              cx={x(c)}
              cy={y(r)}
              r="4.5"
              className="fill-accent stroke-surface"
              strokeWidth="2"
            >
              <title>{`stated ${pct(c)}, right ${pct(r)} (illustrative)`}</title>
            </circle>
          ))}
        </g>
      </svg>

      <figcaption className="mt-3 text-xs leading-5 text-muted">
        Illustrative, not measured results. We will publish real calibration once Horos has run on
        real traffic.
      </figcaption>
    </figure>
  );
}
