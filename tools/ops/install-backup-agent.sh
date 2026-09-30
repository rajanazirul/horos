#!/usr/bin/env bash
# Install (or refresh) the daily backup LaunchAgent on the founder's Mac (docs/runbooks/railway-deploy.md, step 5).
# Copies backup.sh + backup-daily.sh to ~/.local/share/horos-ops (outside ~/Desktop, which macOS protects from
# LaunchAgents) and loads com.horos.backup-daily: daily at 03:00 local, or on wake if asleep. No secrets are copied.
#   RAILWAY_PROJECT_ID=... RAILWAY_ENVIRONMENT_ID=... tools/ops/install-backup-agent.sh
set -euo pipefail
: "${RAILWAY_PROJECT_ID:?}"; : "${RAILWAY_ENVIRONMENT_ID:?}"
src="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.local/share/horos-ops"; logdir="$HOME/Backups/horos"
mkdir -p "$dest" "$logdir"; chmod 700 "$dest" "$logdir"
install -m 700 "$src/backup.sh" "$src/backup-daily.sh" "$dest/"
label=com.horos.backup-daily; plist="$HOME/Library/LaunchAgents/$label.plist"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$dest/backup-daily.sh</string></array>
  <key>WorkingDirectory</key><string>$dest</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.railway/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>RAILWAY_PROJECT_ID</key><string>$RAILWAY_PROJECT_ID</string>
    <key>RAILWAY_ENVIRONMENT_ID</key><string>$RAILWAY_ENVIRONMENT_ID</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$logdir/backup.log</string>
  <key>StandardErrorPath</key><string>$logdir/backup.log</string>
</dict></plist>
PLIST
plutil -lint "$plist" >/dev/null
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $label -> $dest/backup-daily.sh (daily 03:00; log $logdir/backup.log)"
