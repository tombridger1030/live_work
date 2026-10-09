#!/bin/zsh
# Verify the local production server is answering with the build currently in
# the checkout. A healthy process with an old Next build is still a failed
# capture dependency, so the watchdog restarts it and run-web.sh rebuilds.
set -euo pipefail

REPO="/Users/tombridger/Developer/live_work"
PORT="${WORK_LIVE_PORT:-3100}"
LABEL="com.tombridger.tally-web"
BUILD_ID_FILE="$REPO/.next/WORK_LIVE_BUILD_ID"

if [ ! -s "$BUILD_ID_FILE" ]; then
  /bin/echo "$(/bin/date -u +%FT%TZ) missing build identity; restarting web service" >&2
  /bin/launchctl kickstart -k "gui/$(/usr/bin/id -u)/$LABEL" 2>/dev/null || true
  exit 0
fi

BODY="$(/usr/bin/curl --silent --show-error --max-time 15 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
BUILD_ID="$(/bin/cat "$BUILD_ID_FILE")"
# A restart cannot reconnect a disk. Keep the current server alive so mounting
# the volume restores its store immediately, without a rebuild/restart loop.
if [[ "$BODY" == *'"store":"unavailable"'* && "$BODY" == *"\"buildId\":\"$BUILD_ID\""* ]]; then
  /bin/echo "$(/bin/date -u +%FT%TZ) capture storage unavailable; waiting for storage recovery" >&2
  exit 0
fi
if [[ "$BODY" != *'"status":"ready"'* || "$BODY" != *"\"buildId\":\"$BUILD_ID\""* ]]; then
  /bin/echo "$(/bin/date -u +%FT%TZ) web health/build check failed; restarting web service" >&2
  /bin/launchctl kickstart -k "gui/$(/usr/bin/id -u)/$LABEL" 2>/dev/null || true
fi
