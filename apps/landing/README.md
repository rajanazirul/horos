# Horos landing page

Static Next.js (App Router) + Tailwind v4 site. No backend, no analytics, no third-party form service.

Part of the pnpm workspace (`@horos/landing`). Run `pnpm install` once at the repo root, then:

```bash
pnpm --filter @horos/landing dev        # http://localhost:3000
pnpm --filter @horos/landing lint
pnpm --filter @horos/landing typecheck
pnpm --filter @horos/landing build      # static export to ./out, deployable to any static host
```

Every founder-owned placeholder lives in `src/lib/site.ts` or is marked `TODO(founder)`:
`grep -rn "TODO(founder)" src`.
