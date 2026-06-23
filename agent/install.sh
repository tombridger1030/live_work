#!/bin/zsh
# Install / refresh the Work-Live capture agent.
#
# The runtime is copied OUT of the repo into ~/.config/work-live because this
# repo lives under ~/Desktop, which macOS TCC protects: launchd-spawned
# processes cannot read files there. Re-run this after editing capture.ts or
# run-capture.sh so the installed copy stays in sync.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.config/work-live"
LABEL="com.tombridger.work-live"
UID_="$(id -u)"

mkdir -p "$DEST"
chmod 700 "$DEST"
cp "$HERE/capture.ts" "$DEST/capture.ts"
cp "$HERE/run-capture.sh" "$DEST/run-capture.sh"
chmod 700 "$DEST/run-capture.sh"

if [ ! -f "$DEST/env" ]; then
  echo "WARNING: $DEST/env is missing. Create it with WORK_LIVE_BASE_URL," >&2
  echo "         OWNER_SECRET and WORK_LIVE_CAMERA_NAME before the agent can run." >&2
fi

cp "$HERE/$LABEL.plist" "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_" "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl enable "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$UID_/$LABEL"

echo "Installed $LABEL -> $DEST"
echo "Logs: /tmp/work-live-agent.out.log and /tmp/work-live-agent.err.log"
