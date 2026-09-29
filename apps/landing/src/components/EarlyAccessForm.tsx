"use client";

import { useId, useState, type FormEvent } from "react";
import { EARLY_ACCESS_EMAIL } from "@/lib/site";

const AGENT_TYPES = [
  "Invoice or AP agent",
  "Escrow or contractor payouts",
  "Autonomous business operator",
  "x402 seller or API",
  "Something else",
];

const inputCls =
  "mt-1.5 block w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 text-base text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-accent";

export function EarlyAccessForm() {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const kind = String(data.get("kind") ?? "");
    const repo = String(data.get("repo") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter an email address like you@company.com so we can reply.");
      setSent(false);
      return;
    }
    setError(null);

    // TODO(founder): swap this mailto: fallback for a real endpoint when one exists.
    // Deliberately no third-party form service or analytics.
    const body = [
      `Email: ${email}`,
      `Building: ${kind}`,
      repo ? `Project: ${repo}` : null,
      note ? `\n${note}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const href = `mailto:${EARLY_ACCESS_EMAIL}?subject=${encodeURIComponent(
      "Horos early access",
    )}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
    setSent(true);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5" aria-describedby={`${id}-help`}>
      <div>
        <label htmlFor={`${id}-email`} className="text-sm text-ink">
          Work email
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={inputCls}
        />
        {error ? (
          <p id={`${id}-error`} className="mt-2 text-sm text-block">
            {error}
          </p>
        ) : null}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-kind`} className="text-sm text-ink">
            What your agent does
          </label>
          <select id={`${id}-kind`} name="kind" className={inputCls} defaultValue={AGENT_TYPES[0]}>
            {AGENT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-repo`} className="text-sm text-ink">
            Repo or project link <span className="text-muted">(optional)</span>
          </label>
          <input
            id={`${id}-repo`}
            name="repo"
            type="url"
            inputMode="url"
            placeholder="https://github.com/…"
            className={inputCls}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-note`} className="text-sm text-ink">
          Anything we should know <span className="text-muted">(optional)</span>
        </label>
        <textarea id={`${id}-note`} name="note" rows={3} className={inputCls} />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="submit"
          className="inline-flex h-12 shrink-0 items-center justify-center whitespace-nowrap rounded-md bg-accent px-6 text-base font-medium text-accent-ink transition-opacity hover:opacity-90"
        >
          Request early access
        </button>
        <p id={`${id}-help`} className="text-sm text-muted">
          Opens a pre-filled email to {EARLY_ACCESS_EMAIL}.
        </p>
      </div>
      <p aria-live="polite" className="text-sm text-ink">
        {sent
          ? `Your email app should now show a pre-filled draft. Send it to finish your request. If nothing opened, write to ${EARLY_ACCESS_EMAIL} directly.`
          : ""}
      </p>
    </form>
  );
}
