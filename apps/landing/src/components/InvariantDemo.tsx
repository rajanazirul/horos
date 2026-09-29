"use client";

import { useId, useState } from "react";

const MAX = 10000;
const STEP = 250;
const fmt = (n: number) => n.toLocaleString("en-US");

export function InvariantDemo() {
  const sliderId = useId();
  const [policyCap, setPolicyCap] = useState(5000);
  const [model, setModel] = useState(8000);
  const [sanctioned, setSanctioned] = useState(false);

  const ceiling = sanctioned ? 0 : policyCap;
  const effective = Math.min(model, ceiling);
  const clamped = model > ceiling;

  let decision: "allow" | "cap" | "hold" | "block";
  if (sanctioned) decision = "block";
  else if (effective === 0) decision = "hold";
  else if (effective < ceiling) decision = "cap";
  else decision = "allow";

  const decisionColor = {
    allow: "text-allow",
    cap: "text-cap",
    hold: "text-hold",
    block: "text-block",
  }[decision];

  let explanation: string;
  if (sanctioned) {
    explanation =
      "Exact sanctions match. The hard rule sets the ceiling to 0, and nothing the model says can move it.";
  } else if (clamped) {
    explanation = `The model proposed ${fmt(model)}. The contract rejects any raise from the model's role, so the limit stays at the ${fmt(ceiling)} ceiling. Only a person can raise it.`;
  } else if (effective === 0) {
    explanation = "The model graded this counterparty down to 0. The payment waits for a person.";
  } else if (effective < ceiling) {
    explanation = `The model tightened the limit to ${fmt(effective)}, below the ceiling. Tightening is the one thing it's allowed to do.`;
  } else {
    explanation = `The model agreed with the ceiling. The agent may pay up to ${fmt(effective)}.`;
  }

  const pct = (v: number) => `${(v / MAX) * 100}%`;

  return (
    <div className="rounded-md border border-line bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h3 className="text-base font-medium text-ink">Try to raise the limit</h3>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted">
          <input
            type="checkbox"
            checked={sanctioned}
            onChange={(e) => setSanctioned(e.target.checked)}
            className="h-4 w-4 accent-[var(--block)]"
          />
          Exact OFAC SDN match
        </label>
      </div>

      {/* Gauge */}
      <div className="mt-12 mb-10" aria-hidden="true">
        <div className="relative h-10 rounded-sm border border-line bg-bg">
          {/* effective limit fill */}
          <div
            className="absolute inset-y-0 left-0 bg-accent/25 transition-[width] duration-300"
            style={{ width: pct(effective) }}
          />
          {/* region above the ceiling the model cannot reach */}
          <div
            className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--line)_6px_7px)] transition-[left] duration-300"
            style={{ left: pct(ceiling) }}
          />
          {/* ceiling: the incised line */}
          <div
            className="absolute -top-7 bottom-[-0.35rem] w-[3px] -translate-x-1/2 bg-ink transition-[left] duration-300"
            style={{ left: pct(ceiling) }}
          >
            <span className="absolute -top-0.5 left-2 whitespace-nowrap text-xs text-ink">
              ceiling {fmt(ceiling)}
            </span>
          </div>
          {/* model proposal marker */}
          <div
            className="absolute -bottom-7 top-1 w-0 -translate-x-1/2 border-l border-dashed border-cap transition-[left] duration-150"
            style={{ left: pct(model) }}
          >
            <span
              className={`absolute bottom-0 whitespace-nowrap text-xs text-cap ${model > MAX * 0.7 ? "right-2" : "left-2"}`}
            >
              model {fmt(model)}
            </span>
          </div>
        </div>
      </div>

      <label htmlFor={sliderId} className="block text-sm text-muted">
        Limit the model proposes (USDC)
      </label>
      <input
        id={sliderId}
        type="range"
        min={0}
        max={MAX}
        step={STEP}
        value={model}
        onChange={(e) => setModel(Number(e.target.value))}
        aria-valuetext={`${fmt(model)} USDC`}
        className="mt-2 w-full accent-[var(--cap)]"
      />

      <div className="mt-6 rounded-sm border border-line bg-bg p-4" aria-live="polite">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`font-mono text-sm ${decisionColor}`}>{decision}</span>
          <span className="text-sm text-ink">
            Enforced limit: <strong className="font-medium">{fmt(effective)} USDC</strong>
          </span>
        </p>
        <p className="mt-2 text-sm leading-6 text-muted">{explanation}</p>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setPolicyCap((c) => Math.min(MAX, c + 2500))}
          disabled={policyCap >= MAX}
          className="inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-sm text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Raise the cap as a person
        </button>
        <button
          type="button"
          onClick={() => {
            setPolicyCap(5000);
            setModel(8000);
            setSanctioned(false);
          }}
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Reset
        </button>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted">
        A person&apos;s raise is signed and logged as evidence. It never overrides an exact
        sanctions match.
      </p>
    </div>
  );
}
