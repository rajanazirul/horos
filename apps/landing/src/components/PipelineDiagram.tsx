"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { useInViewOnce } from "./Reveal";

/*
  The how-it-works connector. On large screens it is an SVG row whose nodes sit
  above the five step columns; on small screens it animates the steps' own
  vertical rail. Either way a token travels the path once when it scrolls in,
  then fans out to the four possible answers. Labels live in the steps below,
  so the diagram carries no copy of its own beyond the four decision names.
*/

const DECISIONS = [
  { name: "allow", tone: "var(--allow)" },
  { name: "cap", tone: "var(--cap)" },
  { name: "hold", tone: "var(--hold)" },
  { name: "block", tone: "var(--block)" },
] as const;

const TRAVEL = 1600; // ms, kept in sync with .pd-token / .pd-rail in globals.css

// Column starts for a 5-column grid with a 2.5rem gap at the 1104px content width.
const COL = (1104 - 4 * 40) / 5;
const NODES = [0, 1, 2, 3, 4].map((k) => 9 + k * (COL + 40));
const END = NODES[4];

const delay = (ms: number) => ({ "--draw-delay": `${Math.round(ms)}ms` }) as CSSProperties;

export function PipelineDiagram({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useInViewOnce(ref, {
    attr: "data-motion",
    idle: "idle",
    active: "play",
    threshold: 0.1,
    rootMargin: "0px 0px -20% 0px",
  });

  return (
    <div ref={ref} className="mt-14">
      <svg viewBox="0 0 1104 96" className="hidden w-full lg:block" aria-hidden="true" focusable="false">
        <path d={`M9 48H${END}`} stroke="var(--line-strong)" strokeWidth="1" fill="none" />
        <path
          d={`M9 48H${END}`}
          pathLength={1}
          className="draw"
          stroke="var(--accent)"
          strokeWidth="1.5"
          fill="none"
          style={{ "--draw-dur": `${TRAVEL}ms`, transitionTimingFunction: "linear" } as CSSProperties}
        />

        {NODES.map((x) => (
          <g key={x}>
            <circle cx={x} cy="48" r="8.5" fill="var(--bg)" stroke="var(--line-strong)" strokeWidth="1" />
            <circle
              cx={x}
              cy="48"
              r="3"
              fill="var(--accent)"
              className="draw-fade"
              style={delay(((x - 9) / (END - 9)) * TRAVEL)}
            />
          </g>
        ))}

        {DECISIONS.map((d, k) => {
          const y = 12 + k * 24;
          const t = TRAVEL + k * 90;
          return (
            <g key={d.name}>
              <path
                d={`M${END + 9} 48C${END + 40} 48 ${END + 44} ${y} ${END + 76} ${y}`}
                pathLength={1}
                className="draw"
                stroke={d.tone}
                strokeWidth="1.25"
                fill="none"
                style={{ ...delay(t), "--draw-dur": "450ms" } as CSSProperties}
              />
              <g className="draw-fade" style={delay(t + 350)}>
                <rect
                  x={END + 80}
                  y={y - 10}
                  width="64"
                  height="20"
                  rx="3"
                  fill={d.tone}
                  fillOpacity="0.14"
                  stroke={d.tone}
                  strokeWidth="1"
                />
                <text
                  x={END + 112}
                  y={y + 4.5}
                  fontSize="13"
                  textAnchor="middle"
                  fill={d.tone}
                  className="font-mono"
                >
                  {d.name}
                </text>
              </g>
            </g>
          );
        })}

        <g className="pd-token pd-token-x">
          <circle r="10" fill="var(--accent)" fillOpacity="0.22" />
          <circle r="4.5" fill="var(--accent)" />
        </g>
      </svg>

      <div className="relative lg:mt-2">
        {/* Small screens: animate the steps' own vertical rail */}
        <span aria-hidden="true" className="pd-rail absolute left-0 top-0 bottom-0 w-px bg-accent lg:hidden" />
        <span
          aria-hidden="true"
          className="pd-token pd-token-y absolute -left-[4px] z-20 h-[9px] w-[9px] -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_5px_color-mix(in_srgb,var(--accent)_22%,transparent)] lg:hidden"
        />
        {children}
      </div>

      <svg
        viewBox="0 0 320 64"
        className="mt-0 block w-full max-w-[20rem] overflow-visible lg:hidden"
        aria-hidden="true"
        focusable="false"
      >
        {DECISIONS.map((d, k) => {
          const cx = 36 + k * 74;
          const t = TRAVEL + k * 90;
          return (
            <g key={d.name}>
              <path
                d={`M0.5 0C0.5 26 ${cx} 12 ${cx} 38`}
                pathLength={1}
                className="draw"
                stroke={d.tone}
                strokeWidth="1.25"
                fill="none"
                style={{ ...delay(t), "--draw-dur": "450ms" } as CSSProperties}
              />
              <g className="draw-fade" style={delay(t + 350)}>
                <rect
                  x={cx - 32}
                  y="38"
                  width="64"
                  height="22"
                  rx="3"
                  fill={d.tone}
                  fillOpacity="0.14"
                  stroke={d.tone}
                  strokeWidth="1"
                />
                <text x={cx} y="53.5" fontSize="13" textAnchor="middle" fill={d.tone} className="font-mono">
                  {d.name}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
