"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Step chart of one counterparty's on-chain limit across the Continuous Watch
 * example night. Driven by ContinuousWatch's step state: the limit line is
 * revealed up to the active step (stroke-dashoffset transition), and each
 * event mark fades in when its step is reached.
 */

export type TimelineStep = {
  time: string;
  /** Minutes since the first step (Mon 09:00 = 0). Drives the x position. */
  minute: number;
  limit: number;
  decision: "allow" | "cap" | "hold" | "block" | "checking";
  /** A payment the agent attempted at this step, if any. */
  amount?: number;
  /** True for the step where the sanctions list was updated. */
  listUpdate?: boolean;
};

type Props = {
  steps: TimelineStep[];
  active: number;
  /** Top of the y axis (the starting limit). */
  maxLimit: number;
  counterparty: string;
};

const H = 210;
const M_BASE = { top: 26, right: 14, bottom: 26, left: 46 };
// Minutes of padding before the first and after the last event.
const PAD_BEFORE = 60;
const PAD_AFTER = 90;
// How far past its own event each step reveals the line, in minutes.
const TAIL = 90;

// Surface-coloured halo so annotation text stays legible over gridlines.
const HALO = "stroke-surface [paint-order:stroke] [stroke-width:4px] [stroke-linejoin:round]";

const fmt = (n: number) => n.toLocaleString("en-US");

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function LimitTimelineChart({ steps, active, maxLimit, counterparty }: Props) {
  const [wrapRef, W] = useWidth<HTMLDivElement>(480);
  const uid = useId().replace(/:/g, "");
  const titleId = `lt-title-${uid}`;
  const descId = `lt-desc-${uid}`;
  const hatchId = `lt-hatch-${uid}`;

  // Narrow panels (phones) stack day over time in the x labels.
  const narrow = W < 440;
  const M = { ...M_BASE, bottom: narrow ? 38 : M_BASE.bottom };
  const m0 = steps[0].minute - PAD_BEFORE;
  const m1 = steps[steps.length - 1].minute + PAD_AFTER;
  const yMax = maxLimit * 1.1; // headroom so the starting limit isn't on the frame
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (min: number) => M.left + ((min - m0) / (m1 - m0)) * plotW;
  const y = (v: number) => M.top + (1 - v / yMax) * plotH;
  const baseY = y(0);

  // Step-line vertices: hold each limit until the next step's time, then drop/rise.
  const pts: [number, number][] = [[x(steps[0].minute), y(steps[0].limit)]];
  for (let i = 1; i < steps.length; i++) {
    const px = x(steps[i].minute);
    const prev = pts[pts.length - 1];
    if (px !== prev[0]) pts.push([px, prev[1]]);
    if (steps[i].limit !== steps[i - 1].limit) pts.push([px, y(steps[i].limit)]);
  }
  pts.push([x(m1), pts[pts.length - 1][1]]);
  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");

  // Fraction of the path length that lies left of revealX.
  const segLen = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = segLen.reduce((a, b) => a + b, 0) || 1;
  const isLast = active >= steps.length - 1;
  // Never reveal into the next step's event (e.g. the drop one minute after the update).
  const revealX = isLast
    ? x(m1)
    : x(Math.min(steps[active].minute + TAIL, steps[active + 1].minute - 0.5));
  let shown = 0;
  for (let i = 0; i < segLen.length; i++) {
    const [ax] = pts[i];
    const [bx] = pts[i + 1];
    if (bx <= revealX) shown += segLen[i];
    else {
      if (ax < revealX) shown += revealX - ax; // partial horizontal run
      break;
    }
  }
  const frac = Math.min(1, shown / total);

  // X labels: one per distinct moment, skipping ones that would collide.
  const xLabels: { key: string; px: number; text: string }[] = [];
  for (const s of steps) {
    const px = x(s.minute);
    const last = xLabels[xLabels.length - 1];
    if (!last || px - last.px > (narrow ? 36 : 62)) xLabels.push({ key: s.time, px, text: s.time });
  }

  const yTicks = [0, maxLimit / 2, maxLimit];
  const updateIdx = steps.findIndex((s) => s.listUpdate);
  const update = updateIdx >= 0 ? steps[updateIdx] : null;
  const tightenIdx = steps.findIndex((s, i) => i > 0 && s.limit < steps[i - 1].limit);
  const tighten = tightenIdx >= 0 ? steps[tightenIdx] : null;
  const payments = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.amount !== undefined);

  const current = steps[active];
  const summary =
    `Example scenario. The on-chain limit for ${counterparty} starts at ${fmt(steps[0].limit)} USDC` +
    (tighten ? `, drops to ${fmt(tighten.limit)} USDC at ${tighten.time} after a sanctions list update` : "") +
    `. Now showing ${current.time}: limit ${fmt(current.limit)} USDC.` +
    payments
      .filter(({ i }) => i <= active)
      .map(({ s }) => {
        const paid = Math.min(s.amount!, s.limit);
        return ` ${s.time}: ${fmt(s.amount!)} USDC requested, ${fmt(paid)} paid.`;
      })
      .join("");

  const fade = (visible: boolean) =>
    `transition-opacity duration-500 ${visible ? "opacity-100" : "opacity-0"}`;

  return (
    <figure className="m-0">
      <div ref={wrapRef} className="w-full">
        <svg
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto max-w-full overflow-visible"
        >
          <title id={titleId}>{`On-chain limit over time for ${counterparty}`}</title>
          <desc id={descId}>{summary}</desc>
          <defs>
            <pattern
              id={hatchId}
              width="5"
              height="5"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="5" className="stroke-cap" strokeWidth="2" />
            </pattern>
          </defs>

          {/* Grid + y ticks */}
          <g aria-hidden="true">
            {yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={M.left}
                  x2={W - M.right}
                  y1={y(v)}
                  y2={y(v)}
                  className={v === 0 ? "stroke-line-strong" : "stroke-line"}
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
                <text
                  x={M.left - 8}
                  y={y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted font-mono text-[11px] tabular-nums"
                >
                  {fmt(v)}
                </text>
              </g>
            ))}
            {xLabels.map((l) => (
              <text
                key={l.key}
                x={Math.min(Math.max(l.px, M.left + (narrow ? 12 : 28)), W - M.right - (narrow ? 14 : 28))}
                y={narrow ? H - 21 : H - 8}
                textAnchor="middle"
                className="fill-muted font-mono text-[11px] tabular-nums"
              >
                {narrow ? (
                  <>
                    <tspan>{l.text.split(" ")[0]}</tspan>
                    <tspan x={Math.min(Math.max(l.px, M.left + 12), W - M.right - 14)} dy="1.2em">
                      {l.text.split(" ")[1]}
                    </tspan>
                  </>
                ) : (
                  l.text
                )}
              </text>
            ))}
          </g>

          {/* List-update marker */}
          {update ? (
            <g aria-hidden="true" className={fade(active >= updateIdx)}>
              <line
                x1={x(update.minute)}
                x2={x(update.minute)}
                y1={M.top - 12}
                y2={baseY}
                className="stroke-muted"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={x(update.minute) - 5}
                y={M.top - 14}
                textAnchor="end"
                className={`${HALO} fill-muted font-sans text-[11px]`}
              >
                list update
              </text>
            </g>
          ) : null}

          {/* The limit: a 2px step line revealed up to the active step */}
          <path
            d={d}
            fill="none"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={1 - frac}
            className="stroke-ink transition-[stroke-dashoffset] duration-700 ease-out"
          />

          {/* Drop annotation */}
          {tighten ? (
            <text
              aria-hidden="true"
              x={x(tighten.minute) + (x(tighten.minute) + 100 > W - M.right ? -7 : 7)}
              y={y(steps[tightenIdx - 1].limit * 0.7)}
              dy="0.32em"
              textAnchor={x(tighten.minute) + 100 > W - M.right ? "end" : "start"}
              className={`${HALO} fill-ink font-mono text-[11px] tabular-nums ${fade(active >= tightenIdx)}`}
            >
              {fmt(steps[tightenIdx - 1].limit)} → {fmt(tighten.limit)}
            </text>
          ) : null}

          {/* Payments: requested amount as a dot; if capped, the paid part is a solid
              column up to the limit and the withheld part is hatched above it. */}
          {payments.map(({ s, i }) => {
            const amount = s.amount!;
            const paid = Math.min(amount, s.limit);
            const capped = paid < amount;
            const px = x(s.minute);
            const nearRight = px > W - M.right - 110;
            const anchor = nearRight ? "end" : "start";
            const lx = nearRight ? px - 11 : px + 11;
            return (
              <g key={s.time} className={fade(active >= i)}>
                <title>
                  {`${s.time}: ${fmt(amount)} USDC requested, ${fmt(paid)} paid${capped ? `, ${fmt(amount - paid)} waits for review` : ""}`}
                </title>
                {capped ? (
                  <g aria-hidden="true">
                    <rect x={px - 5} y={y(amount)} width="10" height={y(paid) - y(amount)} fill={`url(#${hatchId})`} />
                    <rect x={px - 5} y={y(paid)} width="10" height={baseY - y(paid)} className="fill-cap" />
                  </g>
                ) : null}
                <circle
                  cx={px}
                  cy={y(amount)}
                  r="4.5"
                  className={`${capped ? "fill-ink" : "fill-allow"} stroke-surface`}
                  strokeWidth="2"
                />
                <text
                  aria-hidden="true"
                  x={lx}
                  y={y(amount)}
                  dy={capped ? "-0.9em" : "0.32em"}
                  textAnchor={anchor}
                  className={`${HALO} fill-ink font-mono text-[11px] tabular-nums`}
                >
                  {capped ? (narrow ? fmt(amount) : `${fmt(amount)} asked`) : narrow ? `${fmt(amount)} paid` : `${fmt(amount)} requested`}
                </text>
                {capped ? (
                  <text
                    aria-hidden="true"
                    x={lx}
                    y={y(amount)}
                    dy="0.35em"
                    textAnchor={anchor}
                    className={`${HALO} fill-muted font-mono text-[11px] tabular-nums`}
                  >
                    {narrow ? `→ ${fmt(paid)}` : `${fmt(paid)} paid`}
                  </text>
                ) : null}
                {capped && !narrow ? (
                  // Stacked short lines so the labels fit between the drop line and the column
                  <text
                    aria-hidden="true"
                    x={lx}
                    y={y(amount)}
                    dy="1.6em"
                    textAnchor={anchor}
                    className={`${HALO} fill-muted font-mono text-[11px] tabular-nums`}
                  >
                    {`${fmt(amount - paid)} waits`}
                  </text>
                ) : narrow ? null : (
                  <text
                    aria-hidden="true"
                    x={lx}
                    y={y(amount)}
                    dy="1.45em"
                    textAnchor={anchor}
                    className={`${HALO} fill-muted font-mono text-[11px]`}
                  >
                    paid in full
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs leading-5 text-muted">
        <span>Example scenario, not real traffic.</span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-4 rounded-full bg-ink" />
          on-chain limit
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2 bg-[repeating-linear-gradient(135deg,var(--cap)_0_1.5px,transparent_1.5px_3.5px)]"
          />
          held back by the limit
        </span>
      </figcaption>
    </figure>
  );
}
