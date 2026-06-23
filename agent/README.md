# Work-Live Agent

A launchd job checks every 5 minutes, captures when work is active, and backs
off while the owner is away so the camera/vision pipeline does not burn usage.

## How it works

`launchctl` runs `run-capture.sh` every 5 minutes (`StartInterval`, and once at
load). Each tick:

1. asks `/api/status` whether capture is paused, quiet, or not yet due under
   AFK backoff — if so it exits before the camera is opened;
2. otherwise grabs one frame from the configured camera with `imagesnap`;
3. posts the frame to `/api/browser-capture`, which stores it and rolls the
   current hour into one visible check-in.

Two macOS details shape the layout, and both are load-bearing:

- **The runtime lives in `~/.config/work-live/`, not in this repo.** The repo is
  under `~/Desktop`, which macOS TCC protects; launchd-spawned processes cannot
  read files there. `install.sh` copies `capture.ts` + `run-capture.sh` out.
- **`imagesnap` runs directly under `zsh`, never under `bun`.** Under launchd the
  TCC "responsible process" for camera access would otherwise be `bun`, whose
  hardened runtime lacks the camera entitlement, so macOS hard-denies it (and
  won't even prompt). Running `zsh -> imagesnap` makes `imagesnap` the
  responsible, grantable process. `bun` is used only for the `/api/status` and
  `/api/browser-capture` calls, which never touch the camera.

The agent authenticates with `OWNER_SECRET` against `/api/browser-capture`
(rather than `CAPTURE_SECRET`/`/api/capture`) because that endpoint rolls up the
hour inline. The hourly rollup cron in `vercel.json` only runs on a Vercel
deployment, so a local-only setup needs the inline rollup to make check-ins show
up.

## Requirements

- The app must be reachable at `WORK_LIVE_BASE_URL`. In production this is the
  deployed app (`https://livework-one.vercel.app`); for local work it can be a
  `bun run dev` on `http://127.0.0.1:3100`. When the target is unreachable, a
  tick logs a connection error and posts nothing.
- `imagesnap` installed: `brew install imagesnap`.
- The configured webcam is tried first; `WORK_LIVE_FALLBACK_CAMERA_NAME`
  defaults to `FaceTime HD Camera` when the primary is unavailable or busy.

## One-time setup

1. Install the capture primitive:

   ```sh
   brew install imagesnap
   ```

2. Put secrets outside the repo (`~/.config/work-live/env`, mode `600`):

   ```sh
   mkdir -p ~/.config/work-live && chmod 700 ~/.config/work-live
   cat > ~/.config/work-live/env <<'EOF'
   export WORK_LIVE_BASE_URL="https://livework-one.vercel.app"
   export OWNER_SECRET="match-the-app-OWNER_SECRET"
   export WORK_LIVE_CAMERA_NAME="NexiGo N60 FHD Webcam"
   EOF
   chmod 600 ~/.config/work-live/env
   ```

   `OWNER_SECRET` must equal the app's `OWNER_SECRET`. `WORK_LIVE_CAMERA_NAME`
   must match a name in `imagesnap -l`. Set `IMAGESNAP_BIN` if Homebrew installs
   `imagesnap` somewhere other than `/opt/homebrew/bin/imagesnap`.

3. Install and start the launch agent (copies the runtime out of `~/Desktop`,
   loads the job, and runs one tick):

   ```sh
   ./agent/install.sh
   ```

   Re-run `./agent/install.sh` after editing `capture.ts` or `run-capture.sh` so
   the installed copy under `~/.config/work-live/` stays in sync.

## Verify and inspect

```sh
# one tick by hand (server must be up)
source ~/.config/work-live/env
FRAME="$(mktemp).jpg"; imagesnap -d "$WORK_LIVE_CAMERA_NAME" -w 1 "$FRAME"
bun ~/.config/work-live/capture.ts post "$FRAME"

# logs from launchd runs
cat /tmp/work-live-agent.out.log /tmp/work-live-agent.err.log

# job status / force a run
launchctl print gui/$(id -u)/com.tombridger.work-live | grep -E 'runs|last exit'
launchctl kickstart -k gui/$(id -u)/com.tombridger.work-live
```

The launch check cadence is `StartInterval` (seconds) in
`agent/com.tombridger.work-live.plist` — `300` = check every 5 minutes. The
server can tell a tick to skip before the camera opens: after 30 consecutive
away minutes it captures every 15 minutes, and after 60 away minutes it captures
every 30 minutes. Quiet hours (1–8am), AFK backoff, and unchanged-frame dedup
keep usage low: a near-identical frame reuses the last reading instead of
calling the vision model.

## Deployment (the public page)

The deployed app at `https://livework-one.vercel.app` is the public webpage that
shows each snapshot. It is hosted on Vercel and backed by **Neon Postgres** (the
`live-cam` resource, connected via the Vercel Neon integration, which injects
`POSTGRES_URL`). The snapshot pipeline is:

```
launchd (every 5 min) -> imagesnap -> POST /api/browser-capture
   -> dHash dedup (skip vision if the frame didn't change)
   -> else Qwen3 VL via Vercel AI Gateway on a downscaled frame -> score
   -> Neon: snapshots + hourly_checkins rows (thumbnail bytes in the row)
   -> page renders the latest snapshot; thumbnails served via /api/thumb/<id>
```

There is no object store: thumbnails are persisted as `data:` URIs inside the
snapshot row (see `persistThumbnail` in `lib/store.ts`), so the deploy needs only
Neon. The schema is created lazily on first request (`sqlClient` in
`lib/store.ts`).

Required Vercel env (production): `OWNER_SECRET` (must equal the agent's),
`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`, `WORK_LIVE_VISION_MODEL`
(defaults to `alibaba/qwen3-vl-instruct`), `WORK_LIVE_TIME_ZONE`, plus Neon's
auto-injected `POSTGRES_URL`. `ANTHROPIC_API_KEY` remains a local fallback when
gateway credentials are absent. `CAPTURE_SECRET`/`CRON_SECRET` are set but unused by the hourly
browser-capture path. The Hobby plan caps cron at once-per-day, so there is no
cron; `/api/browser-capture` rolls up the current hour inline on every capture.

Redeploy with `vercel --prod`.
