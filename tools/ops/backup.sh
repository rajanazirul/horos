#!/usr/bin/env bash
# Weekly off-platform backup of the hosted database (Story 2.10, NFR-4), run by the founder on founder-held
# storage. Railway's own daily backups are the first line; this is the copy that survives losing the Railway
# account. Writes a custom-format dump (`pg_dump -Fc`) to $BACKUP_DIR/horos-<UTC timestamp>.dump (never overwriting an
# existing file), a `<dump>.sha256` integrity record next to it, and keeps the 8 newest dumps (with their checksums).
#
#   BACKUP_DATABASE_URL='postgres://...' BACKUP_DIR=/path/on/encrypted/volume tools/ops/backup.sh
#
# BACKUP_DATABASE_URL is the read-only `horos_backup` role (pg_read_all_data; docs/runbooks/railway-deploy.md, step 2). It is passed to pg_dump through the
# environment, never on a command line, and never printed. pg_dump runs in the official postgres image
# ($PG_IMAGE, default postgres:17; must be >= the server's major version) unless PG_DUMP=local selects a local
# pg_dump.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
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

if [[ "${PG_DUMP:-docker}" == "local" ]]; then
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
