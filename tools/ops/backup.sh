#!/usr/bin/env bash
# Weekly off-platform backup of the hosted database (Story 2.10, NFR-4), run by the founder on founder-held
# storage. Railway's own daily backups are the first line; this is the copy that survives losing the Railway
# account. Writes a custom-format dump (`pg_dump -Fc`) to $BACKUP_DIR/horos-<UTC timestamp>.dump (never overwriting an
# existing file), a `<dump>.sha256` integrity record next to it, and keeps the 8 newest dumps (with their checksums).
#
#   PG_DUMP=railway-ssh BACKUP_DB_PASSWORD=... BACKUP_DIR=/path tools/ops/backup.sh   (hosted Railway; default for production)
#   BACKUP_DATABASE_URL='postgres://...' BACKUP_DIR=/path tools/ops/backup.sh             (any reachable Postgres)
#
# Both run as the read-only `horos_backup` role (pg_read_all_data; docs/runbooks/railway-deploy.md, step 2).
# - PG_DUMP=railway-ssh runs pg_dump inside the Railway Postgres container over `railway ssh` (the database has no
#   public URL). BACKUP_DB_PASSWORD is the horos_backup password; it travels on the ssh session's stdin, never on a
#   command line, and is never printed. RAILWAY_PG_SERVICE (default Postgres) and PG_DATABASE (default railway)
#   select the target; the repo must be linked to the Railway project (`railway link`).
# - Otherwise BACKUP_DATABASE_URL is passed to pg_dump through the environment, never on a command line, and never
#   printed. pg_dump runs in the official postgres image ($PG_IMAGE, default postgres:18; must be >= the server's
#   major version) unless PG_DUMP=local selects a local pg_dump.
set -euo pipefail

: "${BACKUP_DIR:?BACKUP_DIR is required}"
MODE="${PG_DUMP:-docker}"
if [[ "$MODE" == "railway-ssh" ]]; then
  : "${BACKUP_DB_PASSWORD:?BACKUP_DB_PASSWORD (the horos_backup password) is required with PG_DUMP=railway-ssh}"
else
  : "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
fi
PG_IMAGE="${PG_IMAGE:-postgres:18}"
KEEP=8

umask 077
mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/horos-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
if [[ -e "$out" || -e "$out.sha256" ]]; then
  echo "backup: $out already exists; refusing to overwrite" >&2
  exit 1
fi
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

if [[ "$MODE" == "railway-ssh" ]]; then
  RAILWAY_BIN="${RAILWAY_BIN:-$(command -v railway || echo "$HOME/.railway/bin/railway")}"
  [[ -x "$RAILWAY_BIN" ]] || { echo "backup: railway CLI not found (set RAILWAY_BIN)" >&2; exit 2; }
  # The password is the first stdin line; the remote shell reads it into PGPASSWORD, then pg_dump streams the dump
  # to stdout (binary-safe over railway ssh, verified 2026-09-29).
  target=(--service "${RAILWAY_PG_SERVICE:-Postgres}")
  # Outside the linked repo (e.g. a LaunchAgent), pass the project and environment explicitly.
  [[ -n "${RAILWAY_PROJECT_ID:-}" ]] && target+=(--project "$RAILWAY_PROJECT_ID")
  [[ -n "${RAILWAY_ENVIRONMENT_ID:-}" ]] && target+=(--environment "$RAILWAY_ENVIRONMENT_ID")
  printf '%s\n' "$BACKUP_DB_PASSWORD" | "$RAILWAY_BIN" ssh "${target[@]}" -- \
    sh -c "IFS= read -r PGPASSWORD; export PGPASSWORD; exec pg_dump -Fc --no-password -h 127.0.0.1 -U horos_backup -d ${PG_DATABASE:-railway}" \
    >"$tmp" 2> >(grep -v '^Using SSH key' >&2)
elif [[ "$MODE" == "local" ]]; then
  command -v pg_dump >/dev/null || { echo "backup: pg_dump not found (unset PG_DUMP to use Docker)" >&2; exit 2; }
  PGURL="$BACKUP_DATABASE_URL" bash -c 'pg_dump -Fc --no-password -d "$PGURL"' >"$tmp"
else
  command -v docker >/dev/null || { echo "backup: docker not found (or set PG_DUMP=local)" >&2; exit 2; }
  PGURL="$BACKUP_DATABASE_URL" docker run --rm -e PGURL "$PG_IMAGE" sh -c 'pg_dump -Fc --no-password -d "$PGURL"' >"$tmp"
fi

# A custom-format dump starts with the magic bytes "PGDMP".
[[ "$(head -c 5 "$tmp")" == "PGDMP" ]] || { echo "backup: pg_dump output is not a custom-format dump" >&2; exit 1; }
mv -n "$tmp" "$out"
[[ -e "$tmp" ]] && { echo "backup: $out appeared meanwhile; refusing to overwrite" >&2; exit 1; }
# Integrity record: `sha256sum -c` / `shasum -a 256 -c` it from $BACKUP_DIR before restoring.
(cd "$BACKUP_DIR" && sha256 "$(basename "$out")") >"$out.sha256"
echo "backup: wrote $out ($(wc -c <"$out" | tr -d ' ') bytes), sha256 $(cut -d' ' -f1 <"$out.sha256")"

# Retention: the newest $KEEP dumps (names sort by timestamp); a removed dump takes its checksum with it. Only
# `horos-*.dump` files count, never the .sha256 records or anything else in the directory.
ls -1 "$BACKUP_DIR"/horos-*.dump 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
  rm -f -- "$old" "$old.sha256"
  echo "backup: removed $old (retention $KEEP)"
done
