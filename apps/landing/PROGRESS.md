# Horos landing page: progress log

Resume rule: re-read this file first; only redo steps not marked done.

- [x] 2026-09-24 Read the innovation strategy (internal planning document)
- [x] 2026-09-24 Scaffold: create-next-app (Next 16.3.6, React 19.2, Tailwind v4, ESLint, src/ dir, App Router)
- [ ] Design tokens + layout (fonts, theme toggle, metadata, OG image, icon)
- [ ] Sections: hero, problem, how-it-works, invariant demo, continuous watch, developers, pricing, FAQ, CTA form, footer
- [ ] Build (static export) + lint pass
- [ ] Dev-server render check

## Design plan (decided)
- Palette dark: basalt #161C21, surface #1D252B, limestone ink #E4E1D8, verdigris #7CC2A6, bronze #CFA55B, hold blue #93AECB, cinnabar #E06A50. Light: marble #EDEFEC / ink #1A2126.
- Type: Spectral (display serif, inscription feel), IBM Plex Sans (body), IBM Plex Mono (code).
- Motif: the "limit line" (horos stone = boundary / lien marker). Memorable element: interactive only-tighten gauge.
- [x] Design tokens + layout, theme toggle, metadata, OG image, icon.svg
- [x] Sections written as components in src/components (Hero, Problem, HowItWorks, Invariant+InvariantDemo, ContinuousWatch, Developers, Pricing, Faq, Closing[FinalCta, Footer], EarlyAccessForm, Code, Header, ThemeToggle); placeholders in src/lib/site.ts
- [x] Build (static export to ./out) + lint clean, first pass
- [x] Visual QA via Playwright (desktop 1440 dark, mobile 360 light): fixed grid overflow at 360px, pipeline connector, header opacity; form validation verified
- [x] Final lint clean + build pass (static export in ./out); dev server stopped
- [x] 2026-09-24 Added Use cases section (src/components/UseCases.tsx, after Continuous Watch; nav link "Use cases"): 5 tabbed example scenarios (contractor payouts, x402 APIs, vendor treasury, marketplace payouts, cross-border suppliers), each labelled "Example scenario, not a customer". Stacked list below sm, table above. Added --code-allow/cap/hold/block tokens so decisions stay legible on the always-dark code bg in light theme. Lint + build clean; QA at 1440 dark and 360 light.
- [x] 2026-09-24 Image hero-stone.webp generated (Gemini gemini-3-pro-image-preview), 1920x815, 40 KB -> public/images/
- [x] 2026-09-24 Image stream.webp generated (Gemini gemini-3-pro-image-preview), 1600x894, 61 KB -> public/images/
- [x] 2026-09-24 Image inscription.webp generated (Gemini gemini-3-pro-image-preview, 2nd attempt), 1600x894, 78 KB -> public/images/
- [x] 2026-09-24 Charts: LimitTimelineChart (src/components/charts/LimitTimelineChart.tsx) replaces the progress bar in the Continuous Watch side panel; step line of the example limit revealed up to the active step, list-update marker, 1,800 allowed payment dot, 1,200 request capped at 250 (solid paid column + hatched held-back part). Big limit number kept. Lint + tsc clean; visual QA pending.
- [x] 2026-09-24 Wired stream.webp into Problem (framed banner + caption) and inscription.webp as FinalCta backdrop (30% dark, 8% multiply light)
- [x] 2026-09-24 Charts: AmountBars (src/components/charts/AmountBars.tsx) in the Use cases detail panel: per-check "requested vs paid" bar pairs coloured by decision (cap partial, block 0, hold hatched pending, allow full); numeric requested/paid fields added next to the amount strings in UseCases.tsx; width transitions on tab change. Lint clean.
- [x] 2026-09-24 Charts: CalibrationPlot (src/components/charts/CalibrationPlot.tsx), standalone reliability diagram labelled illustrative; not placed yet (lead places it). Lint clean.
- [x] 2026-09-24 Reveal: src/components/Reveal.tsx (IntersectionObserver, data-visible, --reveal-delay stagger; hidden state only after mount, skipped if already on screen or reduced motion) + shared useInViewOnce hook; "/* motion */" block in globals.css
- [x] 2026-09-24 HeroFlow: src/components/HeroFlow.tsx under the hero grid. Example payments to one counterparty travel to a boundary stone and resolve allow/cap/hold/block; midway the dashed on-chain limit steps down 5,000 -> 250 and the next 1,200 is capped. ~9.5 s loop, pauses off-screen, static final frame for reduced motion/no JS, compact layout below lg. Caption "Illustrative flow".
- [x] 2026-09-24 PipelineDiagram: src/components/PipelineDiagram.tsx wraps the HowItWorks steps. lg: SVG connector row with 5 nodes aligned to the step columns (replaces the CSS before: line), token travels once on scroll-in, then fans out to allow/cap/hold/block chips. Mobile: animates the steps' own vertical rail + dots, fan-out chips below. Reveal on heading and "Four possible answers" card.
- [x] 2026-09-24 RolesDiagram: src/components/RolesDiagram.tsx in Invariant left column under the roles list. Vertical limit axis, solid "ceiling set by hard rules" with hatched unreachable zone above, dashed current limit, model arrow down only (bronze), person arrow up (the only way up). Draws in once on scroll-in. Reveal on Invariant heading, code excerpt and demo column. InvariantDemo untouched.
- [x] 2026-09-24 Charts visual QA (Playwright, 1440 dark / 1440 light / 360 light): fixed React 19 <title> hydration mismatch, early reveal of the drop at the list-update step, label collisions at 360 (two-line x labels, short payment labels, surface halo on annotations); CalibrationPlot checked via a temporary route (removed). Lint + build clean.
- [x] 2026-09-24 Motion QA (HeroFlow/PipelineDiagram/RolesDiagram/Reveal): lint + build clean; Playwright at 1440 dark, 1440 light, 360 light, no horizontal overflow. Fixes: larger bar scale + stone, capped bar pauses at stone, label halos over the limit line, RolesDiagram label collision + mobile text size.
- [x] 2026-09-24 Integration: hero-stone.webp hero backdrop (40% dark / 7% multiply light), CalibrationPlot placed in HowItWorks with copy, Reveal applied to Problem, ContinuousWatch, UseCases, Developers, Pricing, FAQ. Lint + build clean.
- [x] 2026-09-24 QA fixes (Evidence Collector pass): HeroFlow pause button (WCAG 2.2.2) + label halo/offset, ContinuousWatch log wraps with hanging indent, LimitTimelineChart capped labels stacked (short on <440px) so they clear the drop line, FinalCta backdrop 20% + stronger scrim, submit button nowrap. Lint + build clean; re-checked 1440 dark and 360.
