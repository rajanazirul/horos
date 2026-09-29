import { ThemeToggle } from "./ThemeToggle";

export function Mark({ className = "" }: { className?: string }) {
  // A boundary stone (stele) with one incised line: the limit.
  return (
    <svg viewBox="0 0 20 28" aria-hidden="true" className={className}>
      <path
        d="M3 27V6.5C3 3.5 6 1 10 1s7 2.5 7 5.5V27"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M1 27h18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 14h8" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#invariant", label: "Only-tighten" },
  { href: "#use-cases", label: "Use cases" },
  { href: "#developers", label: "Developers" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/90">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5 text-ink" aria-label="Horos, back to top">
          <Mark className="h-7 w-5" />
          <span className="font-display text-xl font-medium tracking-tight">Horos</span>
        </a>
        <nav aria-label="Primary" className="ml-6 hidden lg:block">
          <ul className="flex items-center gap-6 text-sm text-muted">
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} className="transition-colors hover:text-ink">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <a
            href="#early-access"
            className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
          >
            Early access
          </a>
        </div>
      </div>
    </header>
  );
}
