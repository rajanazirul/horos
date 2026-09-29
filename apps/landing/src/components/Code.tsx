import type { ReactNode } from "react";

/**
 * Tiny, dependency-free highlighter for the handful of snippets on the page.
 * Handles comments, strings, numbers, a keyword list and JSON-style keys.
 */
const KEYWORDS = new Set([
  "import",
  "from",
  "const",
  "await",
  "new",
  "if",
  "return",
  "function",
  "external",
  "require",
  "switch",
  "case",
  "break",
  "export",
  "async",
]);

const TOKEN =
  /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|\b(\d[\d_.]*)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

function highlight(line: string, lang: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of line.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(line.slice(last, idx));
    const [text, comment, str, num, word] = m;
    const key = `${i++}`;
    if (comment !== undefined) {
      // "#" is only a comment in shell snippets
      if (comment.startsWith("#") && lang !== "sh") {
        out.push(text);
      } else {
        out.push(
          <span key={key} className="tok-c">
            {text}
          </span>,
        );
      }
    } else if (str !== undefined) {
      const isKey = lang === "json" && /^\s*:/.test(line.slice(idx + text.length));
      out.push(
        <span key={key} className={isKey ? "tok-k" : "tok-s"}>
          {text}
        </span>,
      );
    } else if (num !== undefined) {
      out.push(
        <span key={key} className="tok-n">
          {text}
        </span>,
      );
    } else if (word !== undefined && KEYWORDS.has(word) && lang !== "json" && lang !== "text") {
      out.push(
        <span key={key} className="tok-w">
          {text}
        </span>,
      );
    } else {
      out.push(text);
    }
    last = idx + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

type CodeProps = {
  code: string;
  lang?: "ts" | "json" | "sh" | "sol" | "text";
  /** Accessible name for the code region, e.g. "Example: calling horos.check" */
  label: string;
  title?: string;
  className?: string;
};

export function Code({ code, lang = "ts", label, title, className = "" }: CodeProps) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <figure
      className={`overflow-hidden rounded-md border border-line bg-code-bg text-code-ink ${className}`}
    >
      {title ? (
        <figcaption className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-[var(--code-muted)]">
          <span>{title}</span>
        </figcaption>
      ) : null}
      <pre
        tabIndex={0}
        aria-label={label}
        className="overflow-x-auto px-4 py-4 font-mono text-[0.8125rem] leading-6"
      >
        <code>
          {lines.map((l, n) => (
            <span key={n} className="block min-h-6">
              {highlight(l, lang)}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
