# Mirror archive integration

`readMirror(day?)` in `lib/mirror.ts` reads exactly the requested local date;
omission means actual today from `lib/time.ts`. Invalid, future, expired,
missing, mismatched, or unreadable documents return `null`. During rollout only,
a missing archive may read `mirror/dashboard.json` if its `data.viewDay` exactly
matches. Never render today's data for an unavailable historical selection.

`readLatestMirror()` reads the legacy latest publication regardless of capture
date. Use it for Ledger, Ledger APIs, and status. It rebuilds the Ledger through
actual today (including new weeks), then applies owner overrides. New dates have
zero captured activity; a sleeping camera cannot prevent manual editing. Status
is recalculated against the current clock; `publishedAt` remains the actual
publication timestamp. Both readers apply dashboard and Ledger overrides.

`listArchivedDays()` is exported from `lib/mirror.ts`. It returns actual retained
archive dates newest-first independently of today's availability. It throws on
storage failure so callers can distinguish unavailable storage from no history.
It lists only the `mirror/archive/days/` manifest prefix, never image objects.
Successful `readMirror` results use this list for `dataDays`, `prevDay`, and
`nextDay`. Asset reads and latest-mirror reads perform no listing.

```text
local capture store (read only)
  -> publishMirror / backfill
     -> mirror/archive/days/YYYY-MM-DD.json    DashboardData + Ledger
     -> mirror/archive/YYYY-MM-DD/frames/id.jpg  immutable compact JPEG
        -> /mirror-assets/YYYY-MM-DD/id        public same-origin image
```

All hourly frames retain metadata and image references. JPEGs are at most 512px
wide, quality 60; day payloads contain no data URI images. Duplicate latest/frame
IDs resolve once, with at most six concurrent image operations. Existing assets
are reused across process restarts; a 1,024-entry, 15-minute successful-existence
cache reduces repeat requests. Missing or
undecodable local thumbnails produce empty URLs and are retried on later runs.
Snapshot image paths use the snapshot's capture date, including a latest frame
referenced by multiple daily documents.

The image route is deliberately public like the dashboard. Private Blob protects
the store token; it does not authenticate page visitors. Only validated archive
dates/IDs can be fetched. No arbitrary Blob URLs or paths are accepted. The route
is outside `/api` redirects and middleware; responses use JPEG/nosniff/no-store.

## Backfill and rollout

From `/Users/tombridger/Developer/live_work` on the capture Mac:

```sh
bun scripts/backfill-mirror-archive.ts --dry-run --archive-only
bun scripts/backfill-mirror-archive.ts --apply --archive-only
```

Use `--day=2026-09-03` to restrict either command to one retained date. Dry-run is
the default. Reports include hourly/frame counts and local image coverage:
`available` means successfully decoded, `unavailable` means missing source bytes,
and `undecodable` means invalid bytes. These are local-source counts, not a claim
that every original image remains recoverable or a remote read-back audit.

`--archive-only` MUST be used before deploying the asset route: it leaves the
legacy latest document untouched, so the old deployment never receives new image
URLs it cannot serve. Once deployed, restart the capture publisher to pick up the
new implementation. Normal publishes update both the current day's archive and
the legacy latest document. Historical backfills never replace the latest mirror.
Backfill disables GitHub synchronization in its own process and uses a
non-persistent Next cache; it does not rewrite the local capture store.

## Retention

Thirty local calendar dates are readable: today plus the previous 29, including
DST transitions. `cleanupArchive({ dryRun: true })` returns expired paths without
deleting. Explicit `dryRun: false` deletes only recognized day manifests and frame
JPEGs under `mirror/archive/`. Future dates, unknown objects, overrides, latest
mirror, and local captures are excluded. Cleanup is independently callable by
the authenticated maintenance endpoint; reads and publishes never delete data.

```sh
bun scripts/backfill-mirror-archive.ts --cleanup --dry-run
```

Actual deletion requires `--cleanup --apply`; no production cleanup was run for
this slice. The separate scheduled maintenance caller is responsible for running
cleanup regularly; read-time expiry alone does not remove stored objects.

## Verification

Focused tests cover exact reads and rollout fallback, midnight/new-week Ledger
editing, archive-only publication, private image encoding and public response
bytes, missing/corrupt sources, storage failure, DST/retention boundaries,
dry-run deletion scope, overlays, and 1,000 frames across 24 hours under 100KB
for the minimal metadata fixture. Real DashboardData is larger than that fixture.
The existing default-hour-only test was intentionally changed to the all-hours
contract; existing correction and Ledger override assertions were preserved.

No UI, code pulse, deployment, commit, or production deletion is part of this
slice. Remote backfill/read-back and deployed browser verification belong to the
integration rollout; unit image decoding does not prove production recovery.
