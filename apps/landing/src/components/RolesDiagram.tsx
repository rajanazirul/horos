"use client";

import { useRef, type CSSProperties } from "react";
import { useInViewOnce } from "./Reveal";

/*
  The three roles on one vertical limit axis. Hard rules fix the ceiling; above it
  is out of reach. The model's arrow only points down. A person's arrow is the
  only one that points up. Decorative: the roles list above says the same in words.
*/

const d = (ms: number, dur?: number) =>
  ({ "--draw-delay": `${ms}ms`, ...(dur ? { "--draw-dur": `${dur}ms` } : {}) }) as CSSProperties;

export function RolesDiagram({ className = "" }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useInViewOnce(ref, { attr: "data-motion", idle: "idle", active: "play", threshold: 0.4 });

  return (
    <svg
      ref={ref}
      viewBox="0 0 480 252"
      className={`block w-full max-w-[30rem] ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern id="roles-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="var(--line-strong)" strokeWidth="1" />
        </pattern>
      </defs>

      {/* Unreachable zone above the ceiling */}
      <rect x="40" y="18" width="440" height="54" fill="url(#roles-hatch)" opacity="0.7" className="draw-fade" style={d(500)} />
      <text
        x="56"
        y="50"
        fontSize="17"
        fill="var(--muted)"
        className="draw-fade font-sans"
        style={{ ...d(650), paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 5, strokeLinejoin: "round" }}
      >
        Above the ceiling: unreachable
      </text>

      {/* Limit axis */}
      <path d="M40 240V14" pathLength={1} className="draw" stroke="var(--line-strong)" strokeWidth="1" fill="none" style={d(0, 600)} />
      <path d="M35 20l5-7 5 7" className="draw-fade" stroke="var(--line-strong)" strokeWidth="1" fill="none" style={d(500)} />
      <text x="32" y="244" fontSize="14" textAnchor="end" fill="var(--muted)" className="font-mono">
        0
      </text>
      <text
        x="20"
        y="130"
        fontSize="14"
        textAnchor="middle"
        fill="var(--muted)"
        className="font-sans"
        transform="rotate(-90 20 130)"
      >
        limit
      </text>

      {/* Ceiling set by hard rules */}
      <path d="M40 72H480" pathLength={1} className="draw" stroke="var(--ink)" strokeWidth="2" fill="none" style={d(250, 700)} />
      <text x="52" y="94" fontSize="17" fill="var(--ink)" className="draw-fade font-sans" style={d(700)}>
        Ceiling set by hard rules
      </text>

      {/* Current limit */}
      <path
        d="M40 150H480"
        className="draw-fade"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeDasharray="6 5"
        fill="none"
        style={d(550)}
      />
      <text x="52" y="142" fontSize="17" fill="var(--accent)" className="draw-fade font-sans" style={d(900)}>
        Current limit
      </text>

      {/* Model: down only */}
      <path d="M170 156V214" pathLength={1} className="draw" stroke="var(--cap)" strokeWidth="2" fill="none" style={d(1000, 450)} />
      <path d="M163 206l7 9 7-9" className="draw-fade" stroke="var(--cap)" strokeWidth="2" fill="none" strokeLinejoin="round" style={d(1350)} />
      <text x="182" y="194" fontSize="17" fill="var(--cap)" className="draw-fade font-sans" style={d(1300)}>
        Model: can only lower
      </text>

      {/* Person: the only way up */}
      <path d="M320 144V84" pathLength={1} className="draw" stroke="var(--ink)" strokeWidth="2" fill="none" style={d(1350, 450)} />
      <path d="M313 92l7-9 7 9" className="draw-fade" stroke="var(--ink)" strokeWidth="2" fill="none" strokeLinejoin="round" style={d(1700)} />
      <text x="332" y="122" fontSize="17" fill="var(--ink)" className="draw-fade font-sans" style={d(1650)}>
        Person: raises it
      </text>
    </svg>
  );
}
