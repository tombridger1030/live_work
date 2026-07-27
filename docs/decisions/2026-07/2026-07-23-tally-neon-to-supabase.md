# Get tally back up, free: Supabase attempt -> self-host on the Mac

- Date: 2026-07-23
- Status: amended 2026-07-24 — pivoted from Supabase to self-host (see amendment)
- Flight: tally runs free and publicly, off the Neon compute-hour cap

## AMENDMENT 2026-07-24 — pivoted to self-host

What changed: we are NOT migrating to Supabase. tally will be **self-hosted on
Tom's Mac**, data on the expansion drive, exposed via a free tunnel. The local
JSON store (already in `lib/store.ts`) is the datastore; no cloud DB.

Why: Supabase-free turned out unavailable. Tom's Supabase account is capped at
**2 active free projects** and both slots are held by active projects (Noctisium
+ cortal/production). Freeing one means sacrificing an active project; Tom won't
pay for a 3rd. Neon-free is out too (its compute-hour cap broke the site, and the
24/7 capture agent structurally can't fit it). A local store has no quota to blow
and puts data on Tom's own drive — which also enables running evals locally.

What remains unchanged / kept:
- The pg adapter (`lib/sql.ts`) + `@vercel/postgres` removal + burn fixes STAY.
  Dormant in self-host (no DB env vars -> local JSON store), they give a
  zero-rework path back to any hosted Postgres later. Not reverted.
- Outcome unchanged: tally reachable + free, no recurring bill.

New END STATE: tally runs on Tom's Mac (under launchd), data at
`WORK_LIVE_DATA_DIR` on `/Volumes/Expansion`, reachable at a free tunnel URL; the
capture agent posts to the local server. $0, no cloud DB.

New DONE WHEN:
1. The tunnel URL returns 200 and renders the dashboard from the local store.
2. A fresh capture writes to the expansion-drive store and appears on the page.
3. No recurring cost.

Open items: macOS Full Disk Access for the expansion drive (TCC); tunnel choice
(Tailscale Funnel vs Cloudflare+domain); optional local-store support for the
feedback/eval pipeline.

Proven 2026-07-24: app runs locally serving the dashboard + `/api/status` from
the local store; writes land in `WORK_LIVE_DATA_DIR` (store.json round-trip). The
pg adapter was also proven against real Postgres 16 before the pivot.

## Plain-English outcome

Right now the public dashboard at livework-one.vercel.app is fully down: Neon
(the Postgres behind it) hit its free **monthly compute-hours** cap and returns
HTTP 402 on every query, so every page 500s. This change moves the data to a
free Supabase project and fixes the code that ran the database awake 24/7, so
the site comes back and stays free — no monthly payment.

END STATE: the public dashboard loads real data again, served from a free
Supabase Postgres, and a fresh webcam capture writes to Supabase and shows up
on the page. No recurring bill.

NOT DOING: preserving the old Neon history (see below), moving thumbnails to
Blob (parked), rewriting the local-JSON dev store, changing any product
behavior or UI.

DONE WHEN:
1. livework-one.vercel.app returns 200 and renders the dashboard from Supabase.
2. A new capture (or a manual insert) appears on the page.
3. No recurring cost; Supabase free tier has no compute-hour meter.

## Why Supabase specifically (not a fresh Neon)

Neon's free tier meters **compute-hours** and expects the DB to auto-suspend
when idle. This app has a launchd capture agent posting every ~5 min around the
clock plus a dashboard poll, so the DB never sleeps and burns ~720 h/month —
structurally incompatible with Neon free, even after the burn fixes. Supabase
free has **no compute-hour meter** (it only pauses after 7 days of *zero*
activity, which our traffic prevents). So the always-on workload is fine there.
The limits that matter on Supabase are DB size (500 MB) and egress, both
comfortable for this data volume.

## Hazard recorded

The Supabase MCP in this environment is wired to the **Cortal production
project** (`fxldwwttlgfmvfvavqyv`: work_orders, decisions, ledger_moves @417k
rows, ...). tally must NOT create tables there. tally gets its **own dedicated
free Supabase project**. The app self-migrates its schema (`CREATE TABLE IF NOT
EXISTS ...` in `lib/store.ts` / `lib/rate-limit.ts`) on first request, so no
admin migration tooling is needed — only a connection string.

## History: start fresh

Old history lives in the quota-suspended Neon DB, which won't accept even a
`pg_dump` while over quota, and we're not paying for a temporary un-suspend.
So tally starts fresh on Supabase. This is low-regret: Neon retains the old
rows, so if the monthly quota resets they can be exported and merged later.
(One-line veto available: attempt a history export instead — needs Neon
reachable + its connection string.)

## Technical decision: driver adapter, not a rewrite

`@vercel/postgres` is the Neon serverless (WebSocket) driver and cannot talk to
Supabase's standard Postgres pooler. Rather than rewrite ~30 call sites, add one
compatibility module `lib/sql.ts` backed by `pg`, exposing the exact surface the
codebase already uses:

- tagged template: `await sql`...${v}`` -> `{ rows, rowCount }`
- parameterized:   `await sql.query(text, params)` -> `{ rows, rowCount }`

`pg`'s native result shape IS `{ rows, rowCount }`, so no per-call-site changes;
only the import path moves (`@vercel/postgres` -> `@/lib/sql`) in `lib/store.ts`,
`lib/rate-limit.ts`, `scripts/benchmark-vision-models.ts`, and the test mock.
`lib/sql.ts` is the single place the driver lives (information hiding): the next
provider swap edits only this file.

Runtime config: `pg.Pool` against Supabase's transaction pooler, `max: 1` per
warm serverless instance, `ssl: { rejectUnauthorized: false }` (encrypts
transport to the pooler; CA verification relaxed — the weakest point, tighten
later with Supabase's CA).

Env var: the adapter reads `WORK_LIVE_POSTGRES_URL` first, falling back to
`POSTGRES_URL`; both `hasPostgresConfig()` checks recognize it too. Reason: the
Neon Vercel integration OWNS ~20 managed vars (`POSTGRES_URL`,
`POSTGRES_PRISMA_URL`, `PGHOST`, `NEON_PROJECT_ID`, ...) and Vercel won't let a
manual `POSTGRES_URL` coexist with the integration's. Setting one unmanaged
`WORK_LIVE_POSTGRES_URL` is the whole cutover — non-destructive, so the Neon
vars stay available for a future history export.

## Burn fixes (ship in same deploy)

The 24/7 driver was the dashboard polling an uncached `/api/status` every 5s.
Historical dashboard reads are already cached (`unstable_cache`, 5-min TTL,
capture-busted). So: (1) cache `/api/status` at the CDN
(`s-maxage=15, stale-while-revalidate`), invisible to the agent's 5-min tick;
(2) slow the client poll 5s -> 60s (focus/visibility refresh still instant).
Homepage `force-dynamic` left as-is: on Supabase it isn't a cost problem and its
reads are already cached.

## Rollback

Revert the 4 import repoints + `lib/sql.ts` + restore `@vercel/postgres`, and
point `POSTGRES_URL` back at a working Neon URL. Data-layer-only; no schema or
UI change.

## Cutover step (Tom)

1. Create a new **free Supabase project** (not the Cortal one,
   `fxldwwttlgfmvfvavqyv`).
2. Copy its **transaction pooler** connection string (Project Settings ->
   Database -> Connection pooling, port 6543), with the DB password filled in.
3. Hand it to me: I run `vercel env add WORK_LIVE_POSTGRES_URL production` and
   `vercel --prod`, then verify the live site returns 200 from Supabase. (Or set
   `WORK_LIVE_POSTGRES_URL` in the Vercel dashboard yourself and redeploy.) The
   app self-migrates its schema on first request; no need to touch Neon.
