#!/bin/zsh
# Work-Live dashboard server — long-running, started by launchd (KeepAlive).
#
# Runs IN PLACE from the repo. Unlike the capture agent (whose ~/Desktop origin
# is TCC-protected and unreadable by launchd), this repo lives under ~/Developer,
# which launchd can read — so no copy-out is needed. The one TCC-gated operation
# is writing the data store to WORK_LIVE_DATA_DIR on the expansion drive: grant
# Full Disk Access to bun (~/.bun/bin/bun) or this run will fail on first write.
#
# Env comes from the repo's .env.local (loaded by bun + Next at startup). It must
# contain the vision + secret vars and WORK_LIVE_DATA_DIR, and must NOT contain
# POSTGRES_*/WORK_LIVE_POSTGRES_URL (their absence selects the local JSON store).
#
# Binds to loopback deliberately. Tailscale Serve strips spoofed identity headers
# and injects the authenticated tailnet user before proxying here; exposing this
# port on the LAN would let a direct caller forge that trusted header.
#
# Assumes a prior production build (`bun run build`). Update flow: pull code ->
# `bun run build` -> `launchctl kickstart -k gui/$(id -u)/com.tombridger.tally-web`.
set -euo pipefail

REPO="/Users/tombridger/Developer/live_work"
BUN="/Users/tombridger/.bun/bin/bun"
PORT="${WORK_LIVE_PORT:-3100}"

cd "$REPO"
exec "$BUN" run start -- -H 127.0.0.1 -p "$PORT"
