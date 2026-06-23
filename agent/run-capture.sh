#!/bin/zsh
# Work-Live capture agent — one tick, run by launchd on a fixed interval.
#
# imagesnap is run DIRECTLY here (not via bun) on purpose. Under launchd the
# macOS TCC "responsible process" for camera access is whatever binary opens it
# or its non-platform parent. A bun-parented capture is hard-denied because bun's
# hardened runtime lacks the camera entitlement. Running zsh -> imagesnap makes
# imagesnap (ad-hoc signed, no hardened runtime) the responsible, grantable
# process, so the camera works headlessly. bun is used only for network I/O.
#
# Installed location: ~/.config/work-live/ (must be OUTSIDE ~/Desktop, which is
# TCC-protected and unreadable by launchd-spawned processes).
set -euo pipefail

DIR="$HOME/.config/work-live"
if [ -f "$DIR/env" ]; then
  source "$DIR/env"
fi
: "${WORK_LIVE_CAMERA_NAME:?WORK_LIVE_CAMERA_NAME is not set in $DIR/env}"

BUN="/Users/tombridger/.bun/bin/bun"
IMAGESNAP="${IMAGESNAP_BIN:-/opt/homebrew/bin/imagesnap}"
# Backup camera tried when the primary is unavailable — e.g. the external webcam
# is unplugged OR busy because the owner is on a video call. Falls back to the
# built-in camera so a call no longer reads as "away".
FALLBACK_CAMERA="${WORK_LIVE_FALLBACK_CAMERA_NAME:-FaceTime HD Camera}"
# Hard cap per camera. imagesnap can BLOCK indefinitely on a busy/wedged camera,
# and launchd will not start the next tick until this one returns — so without a
# timeout one stuck capture freezes all future check-ins. Kept well under the
# 300s launchd interval even if both cameras time out.
CAPTURE_TIMEOUT="${WORK_LIVE_CAPTURE_TIMEOUT:-20}"

# 1. Pause check via the server (no camera opened). Exit quietly when paused.
rc=0
"$BUN" "$DIR/capture.ts" precheck || rc=$?
if [ "$rc" -eq 10 ]; then
  exit 0
fi
if [ "$rc" -ne 0 ]; then
  exit "$rc"
fi

FRAME="$(mktemp -t work-live-frame).jpg"
trap 'rm -f "$FRAME"' EXIT

# Capture one frame from $1 into $FRAME under a hard timeout. perl's alarm sends
# SIGALRM after CAPTURE_TIMEOUT and survives exec, so a hung imagesnap is killed.
# Succeeds only on a clean exit AND a non-empty file.
snap() {
  rm -f "$FRAME"
  perl -e 'alarm shift; exec @ARGV' "$CAPTURE_TIMEOUT" "$IMAGESNAP" -d "$1" -w 1 "$FRAME" >/dev/null 2>&1
  local snap_rc=$?
  [ "$snap_rc" -eq 0 ] && [ -s "$FRAME" ]
}

# 2. Try the primary camera, then the built-in backup. If neither yields a frame
#    (unplugged, busy on a call, or wedged), record an "away" 0 so there is no gap.
if snap "$WORK_LIVE_CAMERA_NAME"; then
  "$BUN" "$DIR/capture.ts" post "$FRAME"
elif [ "$FALLBACK_CAMERA" != "$WORK_LIVE_CAMERA_NAME" ] && snap "$FALLBACK_CAMERA"; then
  "$BUN" "$DIR/capture.ts" post "$FRAME"
else
  "$BUN" "$DIR/capture.ts" absent
fi
