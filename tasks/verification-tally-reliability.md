# Verification — Tally reliability: break it, recover it, prove it

## Tested as the user

- Opened the deployed origin `https://tally-focus.vercel.app` in a dedicated
  Chrome tab.
- Today rendered the current capture, showed `Capture data synced`, and showed
  the actual image age separately from mirror publication time.
- Navigated to an older day. Chrome showed `Capture data is stale`, kept that
  day’s image on that day, and did not present it as today’s frame.
- Returned to today after a fresh real camera capture; Chrome showed the new
  11:10 AM frame and three same-day snapshots.
- Verified the deployed `/mirror-api/status` latest ID and captured time matched
  the local `/healthz` latest ID and captured time.

## Faults injected and recovered

- Reproduced the stale-build watchdog path by replacing the generated build
  marker with a test value. The first run exposed a real launchd bug: Next
  rebuilt, but the package’s final Bun marker write failed because launchd’s
  PATH did not contain Bun. The wrapper now exports explicit Bun and tool paths.
- Reran the identical stale-build fault. The watchdog detected it, launchd
  rebuilt, rewrote the marker, and loopback health returned `ready` with the
  matching build ID in under 60 seconds.
- Restarted the local web service directly and verified `/healthz` recovered.
- Forced a real capture tick after recovery. Camera capture, local storage,
  mirror publication, deployed status, and Chrome all converged on the same
  new capture.
- Used a synthetic HTTP provider to verify one retry for transient 500/503
  responses and zero retries for 401 authentication failures.

## Automated proof

- `bun test tests`: **263 pass, 0 fail, 917 assertions, 38 files**.
- `bun run typecheck`: pass.
- `bun run lint`: pass, 198 files checked.
- `bun run build`: pass; production build and build identity marker generated.
- Added black-box capture-agent tests for bounded retries, authentication
  classification, and storage classification.
- Existing adversarial coverage includes malformed/truncated storage, CAS
  conflicts, retention boundaries, 1,000-frame mirror scale, DST/time-zone
  boundaries, camera liveness, provider failover, quota exhaustion, missing
  credentials, unauthorized routes, rate limits, duplicate writes, and stale
  data semantics.

## End-to-end journey

launchd capture tick -> bounded local status check -> imagesnap frame and
liveness proof -> idempotent authenticated upload -> durable local store ->
mirror publication -> deployed freshness status -> Chrome banner/image ->
external accountability monitor’s deduplicated incident/recovery decision.

## Limits and honesty check

No destructive data operation, owner edit, Telegram alert, or production fault
was injected. The deployed checks were read-only; the local capture and service
restart were routine recovery operations. A literal 48-hour wait, an actual
Telegram delivery, physical camera unplug/replug, removable-drive failure, and
provider outage were simulated in tests rather than held open in production.
The weakest remaining proof is therefore the external Telegram delivery path;
the code now deduplicates and persists incident state, but I did not send a
test alert to the owner’s account.

## What was deleted

Nothing. The temporary stale build marker was restored by the successful build;
existing user changes in `scripts/eval-corrections.ts`, `.firecrawl/`, and
`scripts/_mirror-check.ts` were left untouched.
