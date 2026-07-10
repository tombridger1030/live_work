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
# Hard cap on capture. imagesnap can BLOCK indefinitely on a busy/wedged camera,
# and launchd will not start the next tick until this one returns — so without a
# timeout one stuck capture freezes all future check-ins. Kept well under the
# 300s launchd interval.
CAPTURE_TIMEOUT="${WORK_LIVE_CAPTURE_TIMEOUT:-20}"

# Camera warmup seconds: imagesnap discards frames for this long so the webcam's
# auto-exposure/auto-focus settle before the grab. 1s gave dark, grainy frames
# in dim light; 2s is steadier. Stays well under CAPTURE_TIMEOUT.
CAPTURE_WARMUP="${WORK_LIVE_CAPTURE_WARMUP:-2}"
# Seconds between the scored frame and the liveness proof frame. A frozen feed
# repeats exactly; a live camera should drift from sensor noise, exposure, or motion.
LIVENESS_GAP="${WORK_LIVE_LIVENESS_GAP:-1}"


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
PROOF_FRAME="$(mktemp -t work-live-proof).jpg"
trap 'rm -f "$FRAME" "$PROOF_FRAME"' EXIT

# Capture one frame from $1 into $2 under a hard timeout. perl's alarm sends
# SIGALRM after CAPTURE_TIMEOUT and survives exec, so a hung imagesnap is killed.
# Succeeds only on a clean exit AND a non-empty file.
snap() {
  local camera="$1"
  local output="$2"
  rm -f "$output"
  perl -e 'alarm shift; exec @ARGV' "$CAPTURE_TIMEOUT" "$IMAGESNAP" -d "$camera" -w "$CAPTURE_WARMUP" "$output" >/dev/null 2>&1
  local snap_rc=$?
  [ "$snap_rc" -eq 0 ] && [ -s "$output" ]
}

# 2. Try the primary camera. If it fails (webcam disconnected means gaming on PC,
# not present), record an "away" 0 so there is no gap in the timeline. If only
# the proof capture fails, still post the scored frame: the server marks it away
# because a single agent frame is no longer enough evidence.
if snap "$WORK_LIVE_CAMERA_NAME" "$FRAME"; then
  sleep "$LIVENESS_GAP"
  if snap "$WORK_LIVE_CAMERA_NAME" "$PROOF_FRAME"; then
    "$BUN" "$DIR/capture.ts" post "$FRAME" "$PROOF_FRAME"
  else
    "$BUN" "$DIR/capture.ts" post "$FRAME"
  fi
else
  "$BUN" "$DIR/capture.ts" absent
fi
