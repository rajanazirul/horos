#!/usr/bin/env bash
# Daily off-platform backup for the founder's machine (Story 2.10; Railway volume backups need the Pro plan, so on
# Hobby these dumps are the only backups). Run by the LaunchAgent `com.horos.backup-daily` (docs/runbooks/railway-deploy.md,
# step 5). Reads the horos_backup password from ~/.config/horos/db-passwords.env at run time (never stored here) and
# calls backup.sh (installed next to this script) in railway-ssh mode. Installed outside ~/Desktop by
# `install-backup-agent.sh`, because macOS blocks LaunchAgents from protected folders without Full Disk Access. Output goes to the caller's log; the password is never printed.
set -euo pipefail
cd "$(dirname "$0")"
PWFILE="${HOROS_DB_PASSWORDS:-$HOME/.config/horos/db-passwords.env}"
[[ -r "$PWFILE" ]] || { echo "backup-daily: $PWFILE not readable" >&2; exit 2; }
BACKUP_DB_PASSWORD="$(grep '^HOROS_BACKUP_DB_PASSWORD=' "$PWFILE" | head -1 | cut -d= -f2-)"
[[ -n "$BACKUP_DB_PASSWORD" ]] || { echo "backup-daily: HOROS_BACKUP_DB_PASSWORD missing in $PWFILE" >&2; exit 2; }
export BACKUP_DB_PASSWORD PG_DUMP=railway-ssh BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/horos}"
echo "backup-daily: $(date -u +%Y-%m-%dT%H:%M:%SZ) start"
./backup.sh
echo "backup-daily: $(date -u +%Y-%m-%dT%H:%M:%SZ) done"
