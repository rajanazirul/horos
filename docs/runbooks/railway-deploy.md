# Runbook: deploy Horos to Railway (Story 2.10)

This runbook covers the founder-only steps: everything that needs the founder's Railway, Circle or keystore access. The repo already has the entry points, the Dockerfile, the per-service Railway config, the migrate command, the ops scripts and the smoke workflow. Nothing in this runbook commits a secret or a real URL to the repo.

Conventions:
- `$API` is the api's public base URL once it exists (for example `https://<service>.up.railway.app`). Keep it in your shell only.
- Secrets are typed into Railway's variable editor or read with `read -rs`. Never pass them as command-line arguments, and never put them in a file inside the repo.
- Every step ends with a **Check**. Do not start the next step until the check passes.

Prerequisites: the Railway CLI (`railway login`), `psql` (or Docker: `docker run --rm -it postgres:17 psql ...`), `curl`, `jq`, Foundry `cast` with the `horos-demo-*` keystores, and this repo built locally (`pnpm install && pnpm turbo run build`).

## 1. Create the Railway project, its Postgres and the two services

1. `railway init` (project name `horos`), then add a database: `railway add --database postgres`.
2. Create two empty services from this GitHub repo, named `api` and `worker` (dashboard: New → GitHub Repo, twice, then rename).
3. In each service's Settings → Source, set the **deploy branch to `main`**. Only merged, CI-green commits deploy.
4. In each service's Settings → Config-as-code, set the config file path:
   - `api` → `railway/api.json`
   - `worker` → `railway/worker.json`
5. Do not deploy yet: the roles and variables come first (steps 2 and 3). If Railway starts a build, let it fail on the missing environment; that is expected.

What the config files set (enter these by hand if the file is not picked up; see the note below):

| Setting | `api` | `worker` |
|---|---|---|
| Builder | Dockerfile, `Dockerfile` | Dockerfile, `Dockerfile` |
| Start command | `node services/api/dist/server.js` | `node services/worker/dist/main.js` |
| Pre-deploy command | none (the api never holds the migrator login) | `node services/worker/dist/migrate.js` |
| Healthcheck | `/healthz`, timeout 120 s | none |
| Replicas | default | 1 |
| Restart policy | on failure, 10 retries | on failure, 10 retries |
| Overlap / draining | draining 15 s | overlap 0 s (an old and a new worker never run together), draining 150 s (longer than `MAX_TICK_MS`, so SIGTERM lets the current tick finish) |

**Check:** the project shows `Postgres`, `api` and `worker`. Both deploy from `main`. Each service's deployment settings show the start command (and, for `worker`, the pre-deploy command) from its file (hover the file icon), and `worker` shows 1 replica.

> **Deprecation:** Railway has deprecated config-as-code in favour of Infrastructure as Code. Existing files keep working for legacy services until **2026-12-01**, and new services may ignore them. If the deployment details do not show the file icon, enter the table's values in each service's Settings by hand, and migrate to Infrastructure as Code before 2026-12-01.

## 2. Database roles (least privilege)

Five roles, none of them a superuser. The Railway `postgres` superuser is used only in this step and is never given to a service:

| Role | Login | Privileges | Used by |
|---|---|---|---|
| `horos_app` | no | INSERT and SELECT on records, receipts, snapshots, PolicyVersions and nonces, plus the mutable outbox, job and chain-head rows (granted by the migrations); SELECT on `drizzle.__drizzle_migrations` (migration 0006) | parent of the two service logins |
| `horos_api` | yes | member of `horos_app` only | api `DATABASE_URL` |
| `horos_worker` | yes | member of `horos_app` only | worker `DATABASE_URL` |
| `horos_migrator` | yes | CREATE on the database and the `public` schema; owns what the migrations create | worker `MIGRATOR_DATABASE_URL` (pre-deploy only) |
| `horos_backup` | yes | `pg_read_all_data` (read-only) | `tools/ops/backup.sh` on the founder's machine |

`horos_app` is pre-created here, so migration 0000's `DO` block skips its `CREATE ROLE` and the migrator never needs CREATEROLE. Open a superuser session with the Postgres service's public URL:

```bash
railway connect Postgres        # or: psql "<DATABASE_PUBLIC_URL from the Postgres service>"
```

Then, in psql (each `\prompt` reads a password without echoing it; generate each one with `openssl rand -base64 32 | tr -d '/+='` in another terminal):

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'horos_app') THEN CREATE ROLE horos_app NOLOGIN; END IF;
END $$;
\prompt 'horos_api password: ' api_pw
\prompt 'horos_worker password: ' worker_pw
\prompt 'horos_migrator password: ' migrator_pw
\prompt 'horos_backup password: ' backup_pw
CREATE ROLE horos_api LOGIN PASSWORD :'api_pw' IN ROLE horos_app;
CREATE ROLE horos_worker LOGIN PASSWORD :'worker_pw' IN ROLE horos_app;
CREATE ROLE horos_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrator_pw';
SELECT format('GRANT CREATE ON DATABASE %I TO horos_migrator', current_database()) \gexec
GRANT CREATE ON SCHEMA public TO horos_migrator;
CREATE ROLE horos_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'backup_pw' IN ROLE pg_read_all_data;
```

Store the four passwords in your password manager. Step 3 puts three of them into Railway; the backup password stays with you.

**Check:**

```sql
SELECT rolname, rolsuper, rolcanlogin, rolcreaterole, rolcreatedb,
       ARRAY(SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of
FROM pg_roles r WHERE rolname LIKE 'horos\_%' ORDER BY 1;
SELECT has_database_privilege('horos_migrator', current_database(), 'CREATE') AS db_create,
       has_schema_privilege('horos_migrator', 'public', 'CREATE') AS public_create;
```

Expected: every `horos_*` row has `rolsuper = f`, `rolcreaterole = f` and `rolcreatedb = f`; `horos_api` and `horos_worker` are members of `{horos_app}` only; `horos_backup` of `{pg_read_all_data}` only; `horos_migrator` of nothing; both privilege columns are `t`. (A CI test runs every migration as a role created exactly like this.)

## 3. Set the variables per service

Use Railway reference variables so the database host is never typed. Put the three service passwords from step 2 into project-level shared variables `HOROS_API_DB_PASSWORD`, `HOROS_WORKER_DB_PASSWORD` and `HOROS_MIGRATOR_DB_PASSWORD`, sealed. Never reference `${{Postgres.DATABASE_URL}}` (the superuser) from a service.

**api.** It refuses to boot if `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `MIGRATOR_DATABASE_URL` or `LOCAL_SIGNER_KEYS` is present:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://horos_api:${{shared.HOROS_API_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| `CHAIN_ID` | `5042002` |
| `ARC_RPC_PRIMARY` | `https://rpc.testnet.arc.io` (or a keyed provider URL; sealed if it has a key) |
| `ARC_RPC_SECONDARY` | `https://rpc.testnet.arc.network` |
| `ADMIN_TOKEN` | 32+ random characters (`openssl rand -hex 32`), sealed |
| `JEV_API_KEY` | the Jev (TypeSafe) API key, sealed. Accepted now; used from Epic 4 |
| `TRUSTED_PROXY_HOPS` | `1` (Railway's edge proxy) |
| `PUBLIC_DEMO_SCOPE` | leave unset until step 8 |
| `CHECK_RATE_PER_MINUTE` | optional (default 120) |
| `CHAIN_READ_CACHE_MS` | optional (default 5000; Check-path cache of on-chain Policy and roles; 0 disables) |
| `LOG_LEVEL` | optional (`info`) |

**worker:**

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://horos_worker:${{shared.HOROS_WORKER_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| `MIGRATOR_DATABASE_URL` | `postgresql://horos_migrator:${{shared.HOROS_MIGRATOR_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` (the pre-deploy migrate only) |
| `CHAIN_ID`, `ARC_RPC_PRIMARY`, `ARC_RPC_SECONDARY` | same as the api |
| `JEV_API_KEY` | same as the api, sealed |
| `CHAIN_WRITER` | `circle` (`local` is refused because the image sets `NODE_ENV=production`) |
| `CIRCLE_API_KEY` | the Circle API key, sealed |
| `CIRCLE_ENTITY_SECRET` | the registered entity secret, sealed (register its ciphertext in the Circle console first) |
| `FOUNDER_ALERT_WEBHOOK_URL` | the founder alert webhook (Slack/Discord incoming webhook), sealed |
| `OFAC_SDN_URL` | optional (default: OFAC's published `SDN.CSV`) |
| `TICK_INTERVAL_MS` | optional (default 5000) |
| `MAX_TICK_MS` | optional (default 120000; a longer tick alerts and restarts the worker) |
| `LOG_LEVEL` | optional |

**Check:** list the variable names only (`railway variables --service api --kv | cut -d= -f1`, and the same for `worker`). The api list must not contain `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `MIGRATOR_DATABASE_URL` or `LOCAL_SIGNER_KEYS`. The worker list must contain the Circle pair and `MIGRATOR_DATABASE_URL`. Both contain `JEV_API_KEY`. No value contains the `postgres` superuser. Step 4 is the real test: each service validates its environment at boot and names anything missing or malformed.

## 4. First deploy and healthcheck

Deploy `worker` first (`railway up --service worker`, or push to `main`). Its pre-deploy step migrates the schema as `horos_migrator`; the advisory lock serialises overlapping runs and gives up after 5 minutes. Then deploy `api`. Until the worker's migration has run, the api's `/healthz` answers 503 `schema-behind`, so an api that deploys first simply stays unhealthy until the schema catches up.

**Check:**
1. The worker's pre-deploy log ends with `{"level":"info","service":"migrate","event":"migrations-applied",...}`.
2. The api log shows `"event":"api-listening"` and the deployment turns healthy (Railway polls `/healthz`).
3. `curl -s "$API/healthz"` prints `{"status":"ok","db":"ok","migrations":{"applied":N,"bundled":N}}` with equal numbers.
4. The worker log shows `"event":"worker-started"` with `"chainWriter":"circle"`, then one `"event":"tick"` line about every 5 s. The first tick's `ofac` should be `{"ran":true,"outcome":"activated"}`.
5. No log line contains a password, the admin token, a Circle secret or an RPC path. Search the logs for `horos_api:`, `horos_migrator:`, `sk_`, `TEST_API_KEY`, `LIVE_API_KEY` and your RPC key; there should be no hits.

If a service exits at boot, its log has one line `horos-api: invalid environment: NAME (problem), ...` naming the variables to fix. Values are never printed.

## 5. Backups

1. Railway: Postgres service → Backups → enable daily backups (keep the default retention).
2. Weekly off-platform copy on founder-held, encrypted storage, as the read-only `horos_backup` role:

```bash
read -rs BACKUP_DATABASE_URL   # postgresql://horos_backup:<password>@<public host>:<public port>/<database>, then Enter
export BACKUP_DATABASE_URL BACKUP_DIR=/Volumes/<encrypted>/horos-backups
tools/ops/backup.sh             # writes horos-<UTC timestamp>.dump + .dump.sha256, never overwrites, keeps the 8 newest dumps
unset BACKUP_DATABASE_URL
```

Take the public host and port from the Postgres service's `DATABASE_PUBLIC_URL`, with the `horos_backup` user and password in place of the superuser's. `backup.sh` runs `pg_dump -Fc` in the `postgres:17` image by default. Set `PG_IMAGE=postgres:<major>` if Railway runs a newer major version (check with `SELECT version();`), or `PG_DUMP=local` to use a local `pg_dump`. Put the same four lines in a weekly calendar reminder or a local cron job that reads the URL from your password manager's CLI.

**Check:** the Railway Backups tab lists a backup; `ls -l $BACKUP_DIR` shows the new `horos-<timestamp>.dump` and its `.sha256`; `(cd $BACKUP_DIR && shasum -a 256 -c horos-<timestamp>.dump.sha256)` prints `OK`.

## 6. Restore drill

```bash
tools/ops/restore-drill.sh "$BACKUP_DIR/horos-<date>.dump"
```

The script checks the dump against its `.sha256` (when present), starts a throwaway Postgres container (unique name, random localhost port, removed on exit), restores the dump without owners or grants (the service roles do not exist there), compares the applied migrations with this build's journal, then exports every Scope's chain with `exportScopeChain` and checks it with `verifyChain`. It prints one line per Scope (record count and head hash) and exits non-zero on any break, a malformed Scope id or a migration mismatch.

**Check:** the output ends with `restore-drill: PASS`, the `migrations` line reads `ok`, and every Scope line reads `ok`. Record the date, the dump name and the Scope count in the day-1 checks log (or the ops log). Repeat after every schema change and at least once before the submission freeze.

To rehearse without production data: start any throwaway Postgres, run `DATABASE_URL=<its URL> node tools/ops/seed-drill-db.ts` (add `--tamper` for the negative case), dump it with `backup.sh`, then run the drill. With `--tamper` it must exit 1 and name the enforced Scope.

## 7. Onboard the Horos Demo wallet

The Demo wallet and its role holders are in `fixtures/horos-demo-wallet.json`. Onboarding creates the Customer and its pending enforced Scope. The worker then provisions three Circle EOAs (Registrar, Model, Rules). The Human replaces the deploy-time holders with them, and bind checks the live roles.

```bash
read -rs ADMIN_TOKEN; export ADMIN_TOKEN
FIX=fixtures/horos-demo-wallet.json
PAY=$(jq -r .roles.payment $FIX); WALLET=$(jq -r .policyWallet $FIX)

# 7a. Onboard (admin bearer instead of a Payment-key signature). Repeat until "status":"provisioned".
curl -s -X POST "$API/v1/onboarding" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"payment_address\":\"$PAY\"}" | tee /tmp/horos-onboard.json | jq
REG=$(jq -r .registrar /tmp/horos-onboard.json); MOD=$(jq -r .model /tmp/horos-onboard.json); RUL=$(jq -r .rules /tmp/horos-onboard.json)
```

**Check 7a:** HTTP 200 with `"status":"provisioned"` and three distinct, non-null addresses (HTTP 202 `provisioning` means the worker has not finished; re-run the same request, which is idempotent). The worker log shows `"provision":{"provisioned":1,...}`.

```bash
# 7b. Fund the Registrar and Rules EOAs with testnet USDC for gas (Arc's gas token): https://faucet.circle.com (Arc testnet).
# 7c. The Human grants the roles to the provisioned EOAs (Role enum: 1 Registrar, 2 Model, 3 Rules). Foundry prompts for the keystore password.
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
for pair in "1 $REG" "2 $MOD" "3 $RUL"; do set -- $pair
  cast send "$WALLET" "grantRole(uint8,address,bytes32)" "$1" "$2" "$ZERO" --rpc-url https://rpc.testnet.arc.io --account horos-demo-human
done
```

**Check 7c:** `for r in 0 1 2 3; do cast call $WALLET "roleHolder(uint8)(address)" $r --rpc-url https://rpc.testnet.arc.io; done` prints the Payment address, then `$REG`, `$MOD` and `$RUL` (checksummed), and `cast call $WALLET "human()(address)" --rpc-url https://rpc.testnet.arc.io` is still the Human.

```bash
# 7d. Bind
curl -s -X POST "$API/v1/onboarding/bind" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"payment_address\":\"$PAY\",\"policy_wallet\":\"$WALLET\"}" | jq
```

**Check 7d:** HTTP 200, `"status":"bound"`, `"policyWallet"` equals `$WALLET`, and `scope` is `enforced:<uuid>`. Note the scope for step 8. A 422 `role mismatch: <role>` names the role still held by a deploy-time key; fix it with 7c and re-run. On the next ticks the worker log shows `"indexer":{"wallets":1,...}`, and the three `grantRole` transactions appear as ExternalRecords (actor `human`) in that Scope.

Then `unset ADMIN_TOKEN`.

## 8. Publish the Demo Scope

Set `PUBLIC_DEMO_SCOPE=<scope from 7d>` on the api service and redeploy it.

**Check:** `curl -s "$API/v1/scopes/<scope>/records" | jq '.records | length'` answers without any credentials, and the same request for any other Scope id is refused (4xx) without credentials.

## 9. Run the smoke workflow (separate smoke wallet)

Smoke traffic never goes to the public Demo wallet: it would land in the public Demo Scope and use its New-Payee Cap. Use a **separate smoke PolicyWallet**:

1. Create five fresh keystores `horos-smoke-{human,payment,registrar,model,rules}` (`cast wallet new` then `cast wallet import`), and deploy a second PolicyWallet with `contracts/script/DeployPolicyWallet.s.sol` exactly as in the README's "Deploy the Horos Demo wallet" (same Standard Preset), with those addresses in the `HOROS_*` variables. Do not add it to `fixtures/`.
2. Onboard, grant and bind it with step 7's commands, using the smoke wallet's Payment address, wallet address and `--account horos-smoke-human`. Do not publish its Scope.
3. In GitHub → Settings → Environments, create the environment **`smoke`** with **required reviewer: the founder**, and add these environment secrets (not repository secrets):
   - `HOROS_SMOKE_BASE_URL` = `$API`
   - `HOROS_SMOKE_POLICY_WALLET` = the smoke PolicyWallet
   - `HOROS_SMOKE_PAYMENT_KEY` = the smoke wallet's **Payment** private key (`cast wallet decrypt-keystore horos-smoke-payment`). It can call `pay()` within that wallet's limits, so never deposit more than test amounts into the smoke wallet.
   - optional: `HOROS_SMOKE_P95_MAX_MS` (default 500), `HOROS_SMOKE_CHAIN_ID` (default 5042002)
4. Actions → "Smoke (hosted api)" → Run workflow (`checks` default 5; an empty value also means 5), then approve the `smoke` environment deployment.

Every smoke Check is a first contact, so it queues a Registration and uses the smoke wallet's New-Payee Cap (10 per Policy Period). `hold` answers are acceptable and expected once the cap is used up. Only failed requests, advisory answers (the signature was not accepted) or a p95 over the limit fail the run.

**Check:** the run passes and prints `{"n":5,"failures":0,"advisory":0,"p50Ms":...,"p95Ms":...}` with `p95Ms` ≤ 500. Without the secrets, the steps after the first are skipped and the run shows a "Smoke skipped" notice.

## 10. Fill in the README

Replace the two `TODO(founder)` lines at the top of `README.md`:

```
Status: live on Arc testnet since <date> (api + worker on Railway; Demo wallet bound)
API base URL: <$API>
```

**Check:** `grep -n "TODO(founder)" README.md` no longer lists the Status or API base URL lines, and the base URL answers `/healthz`.

## Roll back a bad deploy

- **Migrations are forward-only.** There are no down migrations, and a rollback never un-applies one. Every migration is written to be additive, so an older image runs on a newer schema: the api's `/healthz` treats a schema *ahead* of the image as healthy and only one *behind* as `schema-behind`.
- **Roll back the code:** in the service's Deployments tab, open the last good deployment and choose **Redeploy** (or `git revert` the bad commit on `main` and let it deploy). Roll back the `worker` and the `api` separately; each keeps running its previous deployment until the new one is healthy.
- **A failed pre-deploy blocks the worker's new deployment:** if `migrate.js` exits non-zero (a bad migration, a lock not taken within 5 minutes, a wrong `MIGRATOR_DATABASE_URL`), Railway does not start the new worker and the previous one keeps running. The api is not blocked by it, but a new api that expects that migration stays `schema-behind` (unhealthy), so Railway keeps the previous api serving. Fix the migration in a new commit; never edit an applied migration.
- **A bad migration that did apply:** write a new forward migration that repairs it. If data is damaged, restore the latest good backup into a new Railway Postgres (`pg_restore` as the superuser, then re-run step 2's role statements), run the restore drill against the same dump first, and repoint the services' reference variables.

## Rotate secrets

Rotate on any suspected exposure, when someone loses access, and at least before the submission freeze. Each rotation ends with the step-4 checks.

| Secret | How |
|---|---|
| `ADMIN_TOKEN` | `openssl rand -hex 32` → update the api variable → the api redeploys. The old token stops working at once. |
| `horos_api` / `horos_worker` / `horos_migrator` password | superuser psql: `\prompt 'new: ' pw` then `ALTER ROLE horos_api PASSWORD :'pw';` → update the matching `HOROS_*_DB_PASSWORD` shared variable → redeploy the service that uses it. Existing connections keep working until they reconnect. |
| `horos_backup` password | the same `ALTER ROLE`, then update your password manager entry. |
| Circle API key | create a new key in the Circle console → update the worker's `CIRCLE_API_KEY` → redeploy → confirm a tick with outbox activity → revoke the old key. |
| Circle entity secret | generate and register a new entity secret ciphertext in the Circle console (the old one stops working when the new one is registered) → update the worker's `CIRCLE_ENTITY_SECRET` → redeploy at once. |
| `JEV_API_KEY` | new key from TypeSafe → update both services → revoke the old key. |
| `FOUNDER_ALERT_WEBHOOK_URL` | create a new incoming webhook → update the worker → delete the old webhook. |
| Smoke Payment key | the smoke wallet's Human calls `grantRole(0, <new payment address>, 0x0…0)` (Checks authenticate against the live Payment role), then update `HOROS_SMOKE_PAYMENT_KEY` in the `smoke` environment and run the smoke workflow. If its answers come back advisory, onboard and bind the smoke wallet again under the new Payment address (step 9.2). |

## Incident response

| Signal | What it means | What to do |
|---|---|---|
| A founder alert arrives (`list-quarantined`, `outbox-retry-exhausted`, `unrecognised-horos-write`, `worker-tick-timeout`) | The worker saw something it must not decide alone | `list-quarantined`: compare the quarantined SDN update with the previous one before accepting removals. `outbox-retry-exhausted`: read the intent's error in the worker log; check Circle status, the signing EOA's gas balance and the RPCs. `unrecognised-horos-write`: a Registrar/Model/Rules key wrote something Horos did not send. Treat that key as compromised: the Human revokes the role at once (`revokeRole`), then rotate the Circle keys. |
| `"indexer":{"errors":[...]}` repeats in consecutive tick lines | The indexer cannot read the chain | Check both RPCs (`cast block-number --rpc-url ...`), the historical-read open check below, and the `eth_getLogs` range. Writes are not confirmed while this lasts; Checks keep working and fall back to the mirror with `chain_state: stale` when the RPCs are down. |
| `"event":"tick-timeout"`, then the worker restarts | One tick ran past `MAX_TICK_MS` (a hung RPC, Circle or webhook call) and the worker exited 1 so Railway restarted it | One occurrence is noise. Repeats: find the slow dependency from the preceding tick lines. If Railway stops restarting (10 retries), redeploy the worker once the dependency is back. |
| `/healthz` answers 503 | `db: "unreachable"`: Postgres is down or the pool is exhausted; `schema-behind`: the worker's migration has not run | Postgres: check the Railway Postgres service and its metrics. Schema: check the worker's pre-deploy log (see "Roll back a bad deploy"). |

## Open checks (not settled by this story)

- **Circle credentials and the `contractExecution` benchmark** (day-1 check 3): measure submit → `COMPLETE` p50/p95 over about 30 writes from the Demo EOAs. Pass if p95 ≤ 2 s (NFR-1). The fallback is the local-key writer, which the worker refuses in production. Using it would need an AD-15 amendment.
- **Arc RPC historical reads and the `eth_getLogs` range:** the indexer uses historical `eth_getCode` (the deploy-block search) and historical `eth_call` (`rolesAt`), with `logs` chunks of at most 2000 blocks. Confirm that both configured RPCs serve archive state and accept a 2000-block range. If they do not, the worker's tick summary shows `indexer.errors`. The fallbacks (from Story 2.7) are storing the deploy block at bind and a role mirror built from `RoleGranted`/`RoleRevoked`.
- **The AD-17 error codes:** internal failures still return a plain `500`, and 403/404/503 reuse `validation_failed` (deferred from Stories 2.8 and 2.9). Settle the AD-17 amendment before the SDK and MCP (Epic 3) branch on `code`.
