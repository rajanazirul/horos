#!/usr/bin/env bash
# Restore drill (Story 2.10, NFR-4): prove a dump restores and every Scope's record chain still verifies.
#   1. start a throwaway Docker Postgres (unique name, random localhost port, removed on exit)
#   2. pg_restore the given dump into it
#   3. run verify-all-scopes (exportScopeChain + verifyChain for every Scope)
#   4. print a per-Scope result; exit non-zero on any break
#
#   tools/ops/restore-drill.sh /path/to/horos-YYYY-MM-DD.dump
#
# Needs Docker, Node >= 24 and the built workspace (`pnpm install && pnpm turbo run build`). Touches no other
# container and never the hosted database. PG_IMAGE (default postgres:18, the hosted server's major version) must be >= the dump's server version.
set -euo pipefail

dump="${1:-}"
if [[ -z "$dump" || ! -f "$dump" ]]; then
  echo "usage: tools/ops/restore-drill.sh <dump file>" >&2
  exit 2
fi
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for pkg in adapters verify schema core; do
  if [[ ! -f "$repo/tools/ops/node_modules/@horos/$pkg/dist/index.js" ]]; then
    echo "restore-drill: @horos/$pkg is not built; run pnpm install && pnpm turbo run build first" >&2
    exit 2
  fi
done
if [[ -f "$dump.sha256" ]]; then
  expected="$(cut -d' ' -f1 <"$dump.sha256")"
  actual="$( (command -v sha256sum >/dev/null && sha256sum "$dump" || shasum -a 256 "$dump") | cut -d' ' -f1)"
  [[ "$expected" == "$actual" ]] || { echo "restore-drill: $dump does not match $dump.sha256" >&2; exit 1; }
  echo "restore-drill: checksum ok"
fi
PG_IMAGE="${PG_IMAGE:-postgres:18}"
name="horos-restore-drill-$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM"
password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" # throwaway, this container only

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "restore-drill: starting $name ($PG_IMAGE)"
docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" -p 127.0.0.1::5432 "$PG_IMAGE" >/dev/null
# -h 127.0.0.1: only the final server listens on TCP (the image's init server is socket-only).
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null || { echo "restore-drill: postgres did not start" >&2; exit 1; }
port="$(docker port "$name" 5432/tcp | head -n 1 | awk -F: '{print $NF}')"

docker exec "$name" psql -q -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE horos_drill" >/dev/null
echo "restore-drill: restoring $(basename "$dump")"
# Roles are cluster-wide and absent here (horos_app, horos_api, horos_worker, horos_migrator, horos_backup), so
# ownership and grants are skipped: the drill checks data and chains, not privileges.
docker exec -i "$name" pg_restore -U postgres -d horos_drill --no-owner --no-privileges --exit-on-error <"$dump"

echo "restore-drill: verifying every Scope chain"
set +e
DATABASE_URL="postgres://postgres:${password}@127.0.0.1:${port}/horos_drill" node "$repo/tools/ops/verify-all-scopes.ts"
rc=$?
set -e
if [[ $rc -eq 0 ]]; then echo "restore-drill: PASS"; else echo "restore-drill: FAIL (exit $rc)" >&2; fi
exit $rc
