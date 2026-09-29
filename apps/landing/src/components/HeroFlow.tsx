"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/*
  The hero's one orchestrated moment. Example payments to one counterparty travel
  toward a boundary stone and resolve to a decision. Midway through the loop the
  on-chain limit steps down (the "live catch"), so the same 1,200 USDC payment that
  was allowed a moment ago is now capped at 250. All values are illustrative.
*/

type Decision = "allow" | "cap" | "hold" | "block";
type Pos = "start" | "stone" | "past" | "held";

// Bar heights use a square-root scale so small and large amounts both stay readable.
const hOf = (usdc: number) => 2.2 * Math.sqrt(usdc);
const CEIL_HIGH = hOf(5000);
const CEIL_LOW = hOf(250);

const PAYMENTS: { amount: number; decision: Decision; row: string; short: string }[] = [
  { amount: 1200, decision: "allow", row: "1,200 USDC sent, within limit", short: "1,200 sent" },
  { amount: 1200, decision: "cap", row: "250 of 1,200 USDC sent", short: "250 of 1,200 sent" },
  { amount: 120, decision: "hold", row: "120 USDC waits for a person", short: "120 waits for a person" },
  { amount: 90, decision: "block", row: "90 USDC stopped, list match", short: "90 stopped" },
];

type Frame = {
  ms: number;
  lowered: boolean;
  log: number;
  pay?: { i: number; pos: Pos; resolved: boolean };
  dim?: boolean;
};

// About 9.5 s per loop.
const FRAMES: Frame[] = [
  { ms: 80, lowered: false, log: 0, pay: { i: 0, pos: "start", resolved: false } },
  { ms: 1100, lowered: false, log: 0, pay: { i: 0, pos: "stone", resolved: false } },
  { ms: 750, lowered: false, log: 1, pay: { i: 0, pos: "past", resolved: true } },
  { ms: 1300, lowered: true, log: 1 },
  { ms: 80, lowered: true, log: 1, pay: { i: 1, pos: "start", resolved: false } },
  { ms: 1100, lowered: true, log: 1, pay: { i: 1, pos: "stone", resolved: false } },
  { ms: 900, lowered: true, log: 2, pay: { i: 1, pos: "stone", resolved: true } },
  { ms: 700, lowered: true, log: 2, pay: { i: 1, pos: "past", resolved: true } },
  { ms: 80, lowered: true, log: 2, pay: { i: 2, pos: "start", resolved: false } },
  { ms: 900, lowered: true, log: 2, pay: { i: 2, pos: "held", resolved: false } },
  { ms: 700, lowered: true, log: 3, pay: { i: 2, pos: "held", resolved: true } },
  { ms: 80, lowered: true, log: 3, pay: { i: 3, pos: "start", resolved: false } },
  { ms: 1100, lowered: true, log: 3, pay: { i: 3, pos: "stone", resolved: false } },
  { ms: 900, lowered: true, log: 4, pay: { i: 3, pos: "stone", resolved: true } },
  { ms: 450, lowered: true, log: 4, dim: true },
];

// Static final frame: used for reduced motion, before JS, and off-screen.
const FINAL: Frame = { ms: 0, lowered: true, log: 4, pay: { i: 1, pos: "stone", resolved: true } };

type Geo = {
  w: number;
  h: number;
  base: number;
  trackEnd: number;
  stone: number; // stele centre
  x: Record<Pos, number>;
  log: boolean;
  font: number;
};

const WIDE: Geo = {
  w: 1104,
  h: 250,
  base: 204,
  trackEnd: 700,
  stone: 604,
  x: { start: 44, held: 520, stone: 572, past: 668 },
  log: true,
  font: 13,
};

const NARROW: Geo = {
  w: 360,
  h: 262,
  base: 186,
  trackEnd: 344,
  stone: 280,
  x: { start: 24, held: 206, stone: 250, past: 326 },
  log: false,
  font: 12,
};

const TONE: Record<Decision, string> = {
  allow: "var(--allow)",
  cap: "var(--cap)",
  hold: "var(--hold)",
  block: "var(--block)",
};

const LABEL =
  "Illustration: an agent's payments travel toward a boundary stone and each resolves to allow, cap, hold or block. Midway, risk changes and the on-chain limit steps down from 5,000 to 250 USDC, so the next 1,200 USDC payment is capped at 250.";

function subscribeReduced(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const getReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function HeroFlow() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useSyncExternalStore(subscribeReduced, getReduced, () => false);
  const [inView, setInView] = useState(false);
  const [step, setStep] = useState(-1); // -1 = static final frame
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || reduced || paused) return; // pause off-screen, on request, or for reduced motion
    const ms = step < 0 ? 1200 : FRAMES[step].ms;
    const t = window.setTimeout(() => {
      // From the static frame, fade out first (last frame), then start the loop.
      setStep((s) => (s < 0 ? FRAMES.length - 1 : (s + 1) % FRAMES.length));
    }, ms);
    return () => window.clearTimeout(t);
  }, [inView, reduced, paused, step]);

  const frame = reduced || step < 0 ? FINAL : FRAMES[step];
  const isStatic = frame === FINAL;

  return (
    <div ref={ref}>
      <div role="img" aria-label={LABEL}>
        <Band geo={WIDE} frame={frame} isStatic={isStatic} className="hidden w-full lg:block" />
        <Band geo={NARROW} frame={frame} isStatic={isStatic} className="mx-auto block w-full max-w-md lg:hidden" />
      </div>
      {reduced ? null : (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {paused ? "Play animation" : "Pause animation"}
          </button>
        </div>
      )}
    </div>
  );
}

function Band({
  geo,
  frame,
  isStatic,
  className,
}: {
  geo: Geo;
  frame: Frame;
  isStatic: boolean;
  className: string;
}) {
  const { w, h, base, stone, font } = geo;
  const ceilHighY = base - CEIL_HIGH;
  const shift = CEIL_HIGH - CEIL_LOW;
  const ceilEnd = stone - 30;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`hf-clip-${w}`}>
          {/* Payments disappear once they are well past the stone */}
          <rect x="0" y="0" width={geo.trackEnd} height={h} />
        </clipPath>
      </defs>

      {/* Track */}
      <line x1="0" y1={base} x2={geo.trackEnd} y2={base} stroke="var(--line-strong)" strokeWidth="1" />
      <text x="0" y={base + 20} fontSize={font} fill="var(--muted)" className="font-sans">
        Your agent
      </text>
      <text x={geo.trackEnd} y={base + 20} fontSize={font} fill="var(--muted)" textAnchor="end" className="font-sans">
        Counterparty
      </text>

      <g className="hf-dim" style={{ opacity: frame.dim ? 0 : 1 }}>
        {/* Payment in flight (drawn first so the limit label stays on top) */}
        <g clipPath={`url(#hf-clip-${w})`}>
          {frame.pay ? <Payment key={frame.pay.i} geo={geo} pay={frame.pay} isStatic={isStatic} /> : null}
        </g>

        {/* The old ceiling stays as a faint ghost once the limit is lowered */}
        <g style={{ opacity: frame.lowered ? 1 : 0, transition: frame.lowered ? "opacity 600ms ease" : "none" }}>
          <line
            x1="0"
            y1={ceilHighY}
            x2={ceilEnd}
            y2={ceilHighY}
            stroke="var(--line-strong)"
            strokeWidth="1"
            strokeDasharray="2 5"
          />
          <text x={ceilEnd} y={ceilHighY - 8} fontSize={font} fill="var(--muted)" textAnchor="end" className="font-mono">
            was 5,000
          </text>
        </g>

        {/* The on-chain limit. It only ever moves down. */}
        <g
          style={{
            transform: `translateY(${frame.lowered ? shift : 0}px)`,
            transition: frame.lowered && !isStatic ? "transform 900ms cubic-bezier(0.6, 0, 0.2, 1)" : "none",
          }}
        >
          <line
            x1="0"
            y1={ceilHighY}
            x2={ceilEnd}
            y2={ceilHighY}
            stroke={frame.lowered ? "var(--cap)" : "var(--ink)"}
            strokeWidth="1.5"
            strokeDasharray="7 5"
            style={{ transition: "stroke 400ms ease" }}
          />
          <text
            x="0"
            y={ceilHighY - 8}
            fontSize={font}
            className="font-mono"
            fill="var(--muted)"
            style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 5, strokeLinejoin: "round" }}
          >
            <tspan>on-chain limit </tspan>
            <tspan fill={frame.lowered ? "var(--cap)" : "var(--ink)"}>{frame.lowered ? "250" : "5,000"} USDC</tspan>
          </text>
        </g>

      </g>

      {/* Boundary stone: the Mark silhouette, scaled up, opaque so payments pass behind it */}
      <g transform={`translate(${stone - 24} ${base - 66}) scale(2.4)`}>
        <path
          d="M3 27V6.5C3 3.5 6 1 10 1s7 2.5 7 5.5V27Z"
          fill="var(--bg)"
          stroke="var(--ink)"
          strokeWidth="0.9"
          strokeLinejoin="round"
        />
        <path d="M1 27.2h18" stroke="var(--ink)" strokeWidth="0.9" strokeLinecap="round" />
        <path d="M6 14h8" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" />
      </g>

      <g className="hf-dim" style={{ opacity: frame.dim ? 0 : 1 }}>
        {geo.log ? <Log x={752} frame={frame} font={font + 1} /> : <Latest geo={geo} frame={frame} isStatic={isStatic} />}
      </g>
    </svg>
  );
}

function Payment({
  geo,
  pay,
  isStatic,
}: {
  geo: Geo;
  pay: NonNullable<Frame["pay"]>;
  isStatic: boolean;
}) {
  const p = PAYMENTS[pay.i];
  const full = hOf(p.amount);
  const { base, font } = geo;
  const x = geo.x[pay.pos];
  const tone = pay.resolved ? TONE[p.decision] : "var(--muted)";

  let scale = 1;
  if (pay.resolved && p.decision === "cap") scale = CEIL_LOW / full;
  if (pay.resolved && p.decision === "block") scale = 0;
  const shown = full * scale;

  const moveMs = pay.pos === "past" ? 700 : pay.pos === "held" ? 900 : 1050;
  // Allowed and capped payments fade once they are past the stone; blocked ones sink at it.
  const fadeOut =
    pay.resolved &&
    !isStatic &&
    (p.decision === "block" || (pay.pos === "past" && (p.decision === "allow" || p.decision === "cap")));

  const label =
    pay.resolved && p.decision === "cap" ? "250" : p.amount.toLocaleString("en-US");

  return (
    <g
      style={{
        transform: `translateX(${x}px)`,
        transition: pay.pos === "start" || isStatic ? "none" : `transform ${moveMs}ms cubic-bezier(0.45, 0, 0.25, 1)`,
      }}
    >
      <g
        style={{
          opacity: fadeOut ? 0 : 1,
          transition: fadeOut ? "opacity 500ms ease 350ms" : "none",
        }}
      >
        {pay.resolved && p.decision === "cap" ? (
          <rect
            x="-6"
            y={base - full}
            width="12"
            height={full}
            fill="none"
            stroke="var(--cap)"
            strokeDasharray="3 3"
            strokeWidth="1"
          />
        ) : null}
        <rect
          x="-6"
          y={base - full}
          width="12"
          height={full}
          fill={tone}
          className={pay.resolved && p.decision === "hold" && !isStatic ? "hf-hold-pulse" : undefined}
          style={{
            transform: `scaleY(${scale})`,
            transformBox: "fill-box",
            transformOrigin: "50% 100%",
            transition: isStatic ? "none" : "transform 450ms cubic-bezier(0.5, 0, 0.2, 1), fill 250ms ease",
          }}
        />
        <text
          x="0"
          y={base - (pay.resolved && p.decision === "block" ? full : shown) - 13}
          fontSize={font}
          textAnchor="middle"
          fill={pay.resolved ? tone : "var(--ink)"}
          className="font-mono"
          // A halo keeps small amounts legible where they cross the dashed limit line
          style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 8, strokeLinejoin: "round" }}
        >
          {label}
        </text>
      </g>
    </g>
  );
}

function Chip({ decision, x, y, font }: { decision: Decision; x: number; y: number; font: number }) {
  return (
    <g>
      <rect
        x={x}
        y={y - font - 4}
        width={font * 4.6}
        height={font + 11}
        rx="4"
        fill={TONE[decision]}
        fillOpacity="0.14"
        stroke={TONE[decision]}
        strokeWidth="1"
      />
      <text x={x + font * 2.3} y={y - 1.5} fontSize={font} textAnchor="middle" fill={TONE[decision]} className="font-mono">
        {decision}
      </text>
    </g>
  );
}

function Log({ x, frame, font }: { x: number; frame: Frame; font: number }) {
  return (
    <g>
      <text x={x} y="28" fontSize={font - 1} fill="var(--muted)" className="font-sans">
        Decisions for one counterparty
      </text>
      <line x1={x} y1="40" x2="1104" y2="40" stroke="var(--line)" strokeWidth="1" />
      {PAYMENTS.map((p, k) => {
        const y = 72 + k * 36;
        const on = k < frame.log;
        return (
          <g
            key={k}
            style={{
              opacity: on ? 1 : 0,
              transform: `translateX(${on ? 0 : -8}px)`,
              transition: on ? "opacity 350ms ease, transform 350ms ease" : "none",
            }}
          >
            <Chip decision={p.decision} x={x} y={y} font={font} />
            <text x={x + font * 4.6 + 14} y={y} fontSize={font} fill="var(--ink)" className="font-sans">
              {p.row}
            </text>
          </g>
        );
      })}
      <g style={{ opacity: frame.lowered && frame.log < 2 ? 1 : 0, transition: frame.log < 2 ? "opacity 300ms ease" : "none" }}>
        <text x={x} y={72 + 36} fontSize={font} fill="var(--cap)" className="font-sans" dy="0">
          Risk changed. Limit lowered on-chain.
        </text>
      </g>
    </g>
  );
}

function Latest({ geo, frame, isStatic }: { geo: Geo; frame: Frame; isStatic: boolean }) {
  const y = geo.base + 56;
  // The static frame shows the live catch (the capped payment), not the last row.
  const k = isStatic ? 1 : frame.log - 1;
  if (frame.lowered && frame.log === 1) {
    return (
      <text x="0" y={y} fontSize={geo.font} fill="var(--cap)" className="font-sans">
        Risk changed. Limit lowered on-chain.
      </text>
    );
  }
  if (k < 0) return null;
  const p = PAYMENTS[k];
  return (
    <g key={k} style={{ animation: "hf-row-in 350ms ease both" }}>
      <Chip decision={p.decision} x={0} y={y} font={geo.font} />
      <text x={geo.font * 4.6 + 10} y={y} fontSize={geo.font} fill="var(--ink)" className="font-sans">
        {p.short}
      </text>
    </g>
  );
}
