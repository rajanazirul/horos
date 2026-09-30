# Ops log

One line per operational event on the hosted deployment (runbook: `railway-deploy.md`).

| Date (UTC) | Event | Result |
|---|---|---|
| 2026-09-29 | First deploy on Railway (`sfo`): Postgres 18.6, api + worker from `main` | `/healthz` ok, migrations 7/7 as `horos_migrator`; secrets sealed; compute limit $15 |
| 2026-09-29 | Demo wallet `0x7ed7…774c` onboarded and bound | Scope `enforced:01a0eb9e-de1c-7476-a673-d2f1d4f90da8`; 3 Human `grantRole` txs indexed as `external` records |
| 2026-09-29 | Indexer catch-up hit the public Arc RPC rate limit | recovered in bursts; paced to 10 chunks/tick with a 30 s per-wallet cooldown (`dde71da`) |
| 2026-09-29 | First off-platform backup (`PG_DUMP=railway-ssh`, as `horos_backup`) | `horos-2026-09-29T070622Z.dump`, 52,372 bytes, sha256 `e0b72d79…1a5b9d`, in `~/Backups/horos` |
| 2026-09-29 | Restore drill on that dump (`postgres:18`) | PASS: checksum ok, migrations 7/7, 1 Scope ok (3 records, head `0x3c89e4…bfc01`) |
| 2026-09-29 | Railway volume backups | not available on Hobby (Pro only); off-platform `backup.sh` dumps are the only backups |
| 2026-09-29 | Daily backup LaunchAgent `com.horos.backup-daily` installed (03:00 local) | test run exit 0: `horos-2026-09-29T070925Z.dump`, checksum ok |
| 2026-09-29 | Smoke PolicyWallet `0x2e23…37ae` deployed with the Circle role wallets as deploy-time holders (no grantRole needed) and bound | Scope `enforced:01a0ec05-b84b-737d-9452-5a47716eaa65` (not published); Registrar/Rules funded 20 USDC |
| 2026-09-29 | Smoke run: 5 signed Checks against the smoke wallet | 0 failures, 0 advisory; server-side p50 110 ms / p95 268 ms; 5 Circle registrations confirmed, 2.4 s unqueued (burst tail 10.9 s, single Registrar lane) |
| 2026-09-29 | Jev latency from the Railway worker | p50 86 ms, p95 133 ms, 0/30 over 300 ms |
