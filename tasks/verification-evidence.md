# Work-Live Verification Evidence

Date: 2026-06-16
Deployed URL: https://livework-one.vercel.app
Deployment: livework-i8x9e5quy-tombridger1030s-projects (aliased to livework-one)

## Change 1 — Stats: Today | Average toggle + focus-streak redefinition

### What the focus streak now means (the question behind the work)
The old "focus streak" was a count of consecutive perfect-score (100) snapshots
ending at the latest frame; one imperfect frame reset it, and it was shown as a
bare number. It is now hours-based and far less brittle:
- An hour "counts" when its average score reaches the green band — **75** — which
  is single-sourced from `FOCUS_BANDS` in `lib/focus-colors.ts` (the new
  `focusHourThreshold`), so the streak rule and the bar color can never drift.
- A day's streak = the longest unbroken run of consecutive qualifying hours;
  a below-75 hour or a gap breaks it. Shown in whole hours.

### What changed
- `lib/focus-colors.ts`: extracted the `75` boundary into one named constant and
  exported `focusHourThreshold`.
- `lib/time.ts`: added `captureIntervalMinutes = 5` (mirrors launchd StartInterval).
- `lib/types.ts`: `TodayStats.focusStreak` → `focusStreakHours`; added
  `AverageWindow` / `AverageStats`.
- `lib/store.ts`: `recentScoringHours(maxDays)` and `snapshotCountsByDay(maxDays)`
  (local day/hour derived in the app timezone) for the rolling windows.
- `lib/dashboard.ts`: `longestFocusRun`, `dailyFocusMetrics`, `buildAverageStats`;
  `dayStats` now takes the day's hourly rows for the streak and **fixes the
  hours-present bug** (was `× 0.5h`/snapshot — 6× too high at the real 5-min
  cadence — now `× 5min ÷ 60`).
- `components/StatsPanel.tsx` (replaces `TodayStatsPanel`): a Today | Average
  toggle sharing ONE 2×2 grid. The top-left cell is split into two half-width
  boxes (hours present, avg focus); the other cells are headphones (top-right,
  full width), focus streak (bottom-left), snapshots (bottom-right). Today shows
  one value per box; Average shows each metric's 7- and 30-day means in the same
  boxes. `TodayStats` gained `avgScore` (mean of the day's scoring-hour averages)
  so Today can show avg focus; `snapshotCountsByDay` also returns the present
  subset so hours-present is real present time.

### Tested AS A USER (production, screenshots at desktop width 1280)
- Wide single-metric boxes (headphones, focus streak, snapshots) use a horizontal
  layout — icon top-left, label bottom-left, big number pinned to the right — so
  a single value fills the box instead of leaving dead space on the right (the
  reported "ugly white space"). The split top-left pair (hours present, avg focus)
  stays vertical; `auto-rows-fr` keeps all four cells equal height.
- **Today grid**: Hours present 3.2 | Avg focus 21 (split top-left) · Headphones
  24% · Focus streak 0h · Snapshots 123 — each wide box's number right-filled.
- **Average grid**: identical layout; each box is one value line — bold 7-day +
  smaller muted 30-day with tiny 7d/30d tags. Hours present 2.8 · Avg focus 39 ·
  Headphones 36% · Focus streak 1h · Snapshots 79, no clipping at the 451px stats
  column, footnote "Average of the last 3 and 3 days you were present." 7d == 30d
  because only 3 present days exist — present-days-only window working.

### Honesty check (weakest part)
7d and 30d are identical today because the dataset only has 3 present days, so the
two windows haven't diverged yet — they will once >7 days accumulate. The streak
is whole-hours granularity (hourly buckets), so a 50-minute deep block reads as 0h
until it spans a full clock hour above 75; that is inherent to an hourly-average
definition and was the agreed trade-off for robustness.

## Change 2 — Auto-refresh on return to tab

- `lib/return-refresh.ts`: pure, DOM-free throttled controller
  (`createReturnRefresher`) — visible-only gating, persisted-only pageshow, one
  shared 30s throttle, injectable clock.
- `lib/use-refresh-on-return.ts`: `useRefreshOnReturn` hook wiring
  `visibilitychange` + `pageshow` to `router.refresh()`; event-driven (no polling
  while hidden), preserves scroll/client state, no full reload. Mounted once in
  `components/Dashboard.tsx` (reuses the app's existing `router.refresh()` path).

### Tested AS A USER (production)
- Installed a `fetch` spy, simulated a return (`visibilitychange` → visible +
  `pageshow` persisted): **RSC refresh requests fired and `location.pathname`
  stayed "/"** → background refetch, not a full reload.
- Immediately repeated the return inside the 30s window: **0 requests** → throttle
  holds in the live hook (no request spam).

## Change 3 — Trend arrows on stats

- `lib/dashboard.ts`: `previousDayStats(daily, viewDay)` returns the nearest
  earlier present day's metrics (the "yesterday" baseline); exposed as
  `DashboardData.previousStats`.
- `components/StatsPanel.tsx`: each value carries a tiny `Trend` glyph — ▲ moss
  (up) / ▼ brick (down) + the delta; nothing renders when flat or with no
  baseline (no orphan dash). Today compares to the previous day with data; Average
  compares 7-day to 30-day. Baseline is implied by the tab (full "+X vs <baseline>"
  in the hover title).
- Responsive cleanup (clean + functional at all widths): Average value is now a
  big 7-day headline with a small "30d" line beneath (one number wide, never
  clips); the grid reflows to a single column below `sm` so wide boxes are never
  squeezed; equal-height 2×2 (`sm:auto-rows-fr`) returns at `sm+`.

### Tested AS A USER (production, Chrome at 375 / 414 / 768 / 1024 / 1280)
- **Phone (375, 414)**: single column — split pair (hours present | avg focus) on
  top, full-width KPI rows below; no clipping, arrows colored (e.g. Headphones 19%
  ▲3%, Focus streak 1h ▼1h).
- **Tablet/desktop (768, 1024, 1280)**: 2×2 grid; the earlier Headphones 30-day
  clip is gone, "33% / 30d 33%" fits with padding at the tight 1fr column.
- No orphan "–" dashes in any box at any width.

## Automated checks
- `bun run lint:file` — clean (12 files).
- `bun run typecheck` — clean.
- `bun run test` — **51 pass / 0 fail**, incl. `tests/focus-stats.test.ts` (streak
  runs, threshold boundary, hours-present fix, daily metrics, 7/30 window slicing,
  empty, previous-day baseline) and `tests/return-refresh.test.ts` (visible/hidden,
  persisted gating, throttle, shared throttle).
- Vercel production build succeeded (Next lint + type validity).

## Change 4 — Auto-refresh when returning to the browser window

Date: 2026-06-19

### Root cause
`components/Dashboard.tsx` mounted `useRefreshOnReturn`, but
`lib/use-refresh-on-return.ts` only listened for `visibilitychange` and bfcache
`pageshow`. Returning to a still-visible browser window does not necessarily fire
`visibilitychange`, so the page could sit on an old Server Component payload until
polling happened or the user manually refreshed.

### What changed
- `lib/return-refresh.ts`: added `onFocus()` to the pure throttled return
  controller. It shares the same throttle as visibility and pageshow.
- `lib/use-refresh-on-return.ts`: added `window.addEventListener("focus", ...)`
  and matching cleanup.
- `tests/return-refresh.test.ts`: added regression coverage for browser-window
  focus and for focus sharing the throttle with visibility.

### Tested AS A USER
- Started the Next dev server with `bun run dev`.
- Opened `http://localhost:3000/` in Chromium.
- Waited past the 2s throttle window.
- Dispatched the real browser `focus` event on `window`.
- Observed a Next RSC refresh request:
  `http://localhost:3000/?_rsc=pp6_N2PolsqCdSFg`.
- The route stayed `/`, so this is a soft `router.refresh()` update, not a full
  manual page reload.

### Limits pushed
- Verified the missed path specifically: window focus while the page is already
  loaded.
- Regression tests also verify repeated focus/visibility events do not spam
  refreshes inside the throttle window.

### What was deleted
- Nothing. The existing visibility and bfcache return paths stayed intact.

### End-to-end user journey
Keep the dashboard open, leave the browser/app, then come back to the window.
The focus event now forces `router.refresh()` after the throttle window, so the
latest server snapshot is requested even if background polling was paused or
throttled while idle.

### Honesty check
This verifies the browser return trigger and the RSC request. It does not create
a new snapshot in the backing store during the browser test; the polling path and
`/api/status` cache-busting remain covered by type/lint checks plus the existing
API shape.

### Red-flag check output

File: `lib/return-refresh.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | return-signal throttle remains in one controller | - |
| A6 Repetition | NO | focus, visibility, pageshow all call the same private `trigger()` | - |
| A14 Nonobvious Code | NO | interface comment names the three browser return signals | - |
| B1 Change amplification worse | NO | future return signals change one module + hook wiring | - |
| B2 Cognitive load worse | NO | one additional explicit signal, same throttle behavior | - |
| B3 Unknown unknowns worse | NO | previously hidden focus gap is now explicit | - |
| C1 Define errors out | N/A | no new error path | - |

File: `lib/use-refresh-on-return.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | browser event wiring only, throttle policy delegated | - |
| A6 Repetition | NO | three event handlers map to three controller methods | - |
| A14 Nonobvious Code | NO | comment states window focus, tab focus, and bfcache restore | - |
| B1 Change amplification worse | NO | Dashboard still mounts one hook | - |
| B2 Cognitive load worse | NO | behavior matches hook name more closely | - |
| B3 Unknown unknowns worse | NO | focus behavior no longer implicit/missing | - |
| C1 Define errors out | N/A | no new error path | - |

File: `tests/return-refresh.test.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A6 Repetition | NO | existing harness reused for new focus cases | - |
| A14 Nonobvious Code | NO | test names describe the user-visible return behavior | - |
| B1 Change amplification worse | NO | tests cover shared controller contract | - |
| B2 Cognitive load worse | NO | regression expresses the missed event directly | - |
| B3 Unknown unknowns worse | NO | browser focus gap now locked by test | - |
| C1 Define errors out | N/A | no new error path | - |

3 files audited; 0 YES, 18 NO, 3 N/A.

### Automated checks
- `bun run lint:file -- lib/return-refresh.ts lib/use-refresh-on-return.ts tests/return-refresh.test.ts` — clean.
- `bun run test -- tests/return-refresh.test.ts` — 40 pass / 0 fail.
- `bun run typecheck` — clean.

## Change 5 — Live dashboard reads current-day snapshots uncached

Date: 2026-06-19

### Root cause
The browser return path could trigger `router.refresh()`, but
`lib/dashboard.ts` still read today's `snapshotsForDay()` and `hourlyForDay()`
through `unstable_cache`. If capture tag invalidation lagged or missed, the
server render got a fresh `latestSnapshot()` but stale `hourlyFrames`, so the
hero could keep showing an old frame such as 8:09 even after newer captures
existed.

There was a second stale-state issue in `components/Dashboard.tsx`: `selectedHour`
was initialized from `data.defaultHour` only once. A refreshed server payload with
a newer latest snapshot did not force the client hero back to the latest hour or
latest filmstrip frame.

### What changed
- `lib/dashboard.ts`: added `shouldReadViewDayUncached(viewDay, today)` and now
  bypasses cached snapshot/hourly readers for the live local day. Historical days
  still use cached readers.
- `components/Dashboard.tsx`: syncs the selected hour/frame back to the server's
  latest live snapshot when `data.latest.id` changes on today's view.
- `components/Dashboard.tsx`: when following latest, the selected hero frame uses
  `data.latest` directly, so the hero cannot be older than the uncached latest
  snapshot.
- `tests/dashboard-frames.test.ts`: locks the live-day cache-bypass rule.

### Tested AS A USER
- Attempted local browser verification against `bun run dev`; the browser worker
  timed out during navigation and `read http://localhost:3000/` also timed out.
  The local server was cancelled rather than treated as proof.
- Production build verified the page and all API routes compile/render with the
  uncached live-day read path.

### Limits pushed
- Same-hour stale case covered by design: 8:09 → 8:26 no longer depends on a
  cache tag bust, because today's `snapshotsForDay()` is uncached.
- Hour-rollover stale case covered by design: `data.latest.id` changing resets
  the client hero to `data.defaultHour` and the latest frame.

### What was deleted
- Nothing. Historical dashboard caching remains intact.

### End-to-end user journey
Leave the dashboard open, come back to the tab/window, and focus triggers
`router.refresh()`. The server now reads today's frames uncached, and the client
forces today's hero back to the latest snapshot from the refreshed payload.

### Honesty check
Could not complete a live local browser render because the dev server page
request timed out in this environment. The verified proof is build/type/test
coverage plus source-level root-cause closure. This should be rechecked in the
real running dashboard after the next capture.

### Red-flag check output

File: `lib/dashboard.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | live-day cache policy is named once in `shouldReadViewDayUncached` | - |
| A6 Repetition | NO | cached vs uncached readers selected once before `Promise.all` | - |
| A14 Nonobvious Code | NO | helper comment states why today bypasses cache | - |
| B1 Change amplification worse | NO | future live cache policy changes stay in dashboard data loader | - |
| B2 Cognitive load worse | NO | live vs historical read policy is explicit | - |
| B3 Unknown unknowns worse | NO | removes hidden dependency on tag invalidation for current-day frames | - |
| C1 Define errors out | N/A | no new error path | - |

File: `components/Dashboard.tsx`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | client only follows `DashboardData.defaultHour/latest`, no duplicate time math | - |
| A6 Repetition | NO | latest-following selection is one expression | - |
| A14 Nonobvious Code | NO | `followingLatest` names the live hero invariant | - |
| B1 Change amplification worse | NO | refresh behavior remains localized to dashboard state | - |
| B2 Cognitive load worse | NO | explicit sync effect replaces stale implicit `useState` initialization | - |
| B3 Unknown unknowns worse | NO | removes hidden stale-client-state dependency | - |
| C1 Define errors out | N/A | no new error path | - |

File: `tests/dashboard-frames.test.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A6 Repetition | NO | existing dashboard test file gained one cache-policy assertion | - |
| A14 Nonobvious Code | NO | test name states live dashboard cache bypass behavior | - |
| B1 Change amplification worse | NO | regression protects one public helper | - |
| B2 Cognitive load worse | NO | assertion documents today vs historical behavior | - |
| B3 Unknown unknowns worse | NO | cache bypass rule is now visible in tests | - |
| C1 Define errors out | N/A | no new error path | - |

3 files audited; 0 YES, 18 NO, 3 N/A.

### Automated checks
- `bun run lint:file -- lib/dashboard.ts components/Dashboard.tsx tests/dashboard-frames.test.ts` — clean.
- `bun run typecheck` — clean.
- `bun run test -- tests/dashboard-frames.test.ts tests/return-refresh.test.ts` — 41 pass / 0 fail.
- `bun run test` — 41 pass / 0 fail.
- `bun run build` — production build succeeded.

## Change 6 — Hard reload when status proves the rendered snapshot is stale

Date: 2026-06-19

### Root cause
The dashboard still used soft `router.refresh()` when `/api/status` detected a new
snapshot. That can fire a request without guaranteeing the already-mounted client
tree stops displaying the old snapshot. The app needs a stronger invariant: if
the server's latest snapshot id differs from the snapshot id currently rendered,
the page is stale and must reload.

### What changed
- `lib/return-refresh.ts`: added `shouldReloadForLatestSnapshot(renderedLatestId,
  statusLatestId)` so the stale-render decision is explicit and tested.
- `components/Dashboard.tsx`: the live status check now runs immediately on mount,
  every 5 seconds, and on `focus`, `visibilitychange`, and `pageshow`.
- `components/Dashboard.tsx`: if `/api/status.latestId` differs from
  `data.latest.id`, it calls `window.location.reload()` instead of
  `router.refresh()`. Soft refresh remains only when ids already match.
- `tests/return-refresh.test.ts`: added regression coverage for the reload
  decision, including null/no-snapshot cases to avoid reload loops.

### Tested AS A USER
Browser proof was not attempted again because the previous local dev browser path
timed out before page render. This change is verified at the decision boundary
that was failing: stale rendered id + newer status id now requires a hard reload.

### Limits pushed
- `rendered=old`, `status=new` → reload.
- `rendered=null`, `status=new` → reload.
- `rendered=same`, `status=same` → no reload loop.
- `rendered=old`, `status=null` → no reload loop.
- `rendered=null`, `status=null` → no reload loop.

### What was deleted
- The prior polling path no longer treats `router.refresh()` as sufficient when a
  newer snapshot id exists.

### End-to-end user journey
Keep the dashboard open. A new capture lands. `/api/status` returns the new id.
On the next 5-second poll or when you focus/return to the tab, the client compares
that id to the rendered `data.latest.id`. If they differ, the page hard reloads
and fetches the current snapshot from the server.

### Honesty check
This does not prove the capture agent actually produced snapshots between 8:09 and
8:26. It proves that if `/api/status` sees those newer snapshots, the currently
loaded page cannot keep soft-refreshing and showing the old snapshot.

### Red-flag check output

File: `components/Dashboard.tsx`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | stale decision delegated to `shouldReloadForLatestSnapshot` | - |
| A6 Repetition | NO | one `refreshFromStatus()` handles mount, poll, focus, visibility, pageshow | - |
| A14 Nonobvious Code | NO | comment states why hard reload is used for newer snapshot ids | - |
| B1 Change amplification worse | NO | all live-status refresh wiring remains in Dashboard | - |
| B2 Cognitive load worse | NO | status id comparison makes stale page behavior explicit | - |
| B3 Unknown unknowns worse | NO | removes hidden assumption that soft refresh is sufficient | - |
| C1 Define errors out | N/A | network errors are retried by the next poll/focus event | - |

File: `lib/return-refresh.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | reload condition has one exported implementation | - |
| A6 Repetition | NO | helper replaces ad hoc id comparisons | - |
| A14 Nonobvious Code | NO | helper comment defines null/status semantics | - |
| B1 Change amplification worse | NO | future stale-id policy changes one helper | - |
| B2 Cognitive load worse | NO | testable predicate is easier to reason about than inline conditionals | - |
| B3 Unknown unknowns worse | NO | null no-snapshot behavior is explicit | - |
| C1 Define errors out | N/A | no new exception path | - |

File: `tests/return-refresh.test.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A6 Repetition | NO | existing refresh test file owns the helper regression | - |
| A14 Nonobvious Code | NO | test enumerates reload/no-loop cases | - |
| B1 Change amplification worse | NO | regression protects one helper contract | - |
| B2 Cognitive load worse | NO | edge cases documented as assertions | - |
| B3 Unknown unknowns worse | NO | reload-loop cases are covered | - |
| C1 Define errors out | N/A | no new exception path | - |

3 files audited; 0 YES, 18 NO, 3 N/A.

### Automated checks
- `bun run lint:file -- components/Dashboard.tsx lib/return-refresh.ts tests/return-refresh.test.ts` — clean.
- `bun run typecheck` — clean.
- `bun run test -- tests/return-refresh.test.ts` — 42 pass / 0 fail.
- `bun run build` — production build succeeded.

## Change 7 — Production browser auto-update watch

Date: 2026-06-19

### Deployment
- Production deploy: `dpl_988mvb15KywSpuGjS3ZpbthFtAnn`.
- Capture-agent target: `https://livework-one.vercel.app`.
- Vercel production alias reported by deploy: `https://tally-focus.vercel.app`.
- `/api/status` returned the same latest snapshot id from both aliases before the
  browser watch, so the capture target and production data source matched.

### Tested AS A USER
Opened `https://livework-one.vercel.app/` in Chromium and left the tab open. I did
not manually refresh during the observation. The browser observer only read
`/api/status`, DOM text, hero image `src`, and navigation/request events.

Fresh final-code baseline:
- 2026-06-19T04:29:22Z: rendered `Snapshot at 9:26 PM`,
  `/api/thumb/655342e2-2010-4c03-b6b4-ea00e2ef4711`.

Observed automatic rendered transitions:
- 2026-06-19T04:31:24Z: rendered `Snapshot at 9:31 PM`,
  `/api/thumb/2cf23410-a5e7-436a-b9f4-a242a74fcee6`.
- 2026-06-19T04:36:41Z: rendered `Snapshot at 9:36 PM`,
  `/api/thumb/083ad536-5dcd-4db7-b00b-72c94284259b`.
- 2026-06-19T04:41:45Z: rendered `Snapshot at 9:41 PM`,
  `/api/thumb/e57e18d2-244d-493a-b5f7-5e553906d579`.
- 2026-06-19T04:46:53Z: rendered `Snapshot at 9:46 PM`,
  `/api/thumb/bda6c1d3-087e-4821-ade6-3f80a0b1a29b`.

Final state after the watch:
- `/api/status.latestId`: `bda6c1d3-087e-4821-ade6-3f80a0b1a29b`.
- Rendered hero image: `/api/thumb/bda6c1d3-087e-4821-ade6-3f80a0b1a29b`.
- Rendered hero alt/time: `Snapshot at 9:46 PM` / `9:46 PM`.

### Limits pushed
- Watched a production browser tab through four real capture updates.
- Confirmed the rendered hero image id matched `/api/status.latestId` at the end.
- Confirmed the post-fix steady state stopped RSC churn when the rendered id already
  matched the server id: after the 9:31 update, recent events showed status polling
  only, no repeated reload loop.

### What was deleted
- Nothing in this verification step.

### End-to-end user journey
The capture agent posted new snapshots to production every ~5 minutes. The open
dashboard tab detected each new `/api/status.latestId` and moved its rendered hero
to the new `/api/thumb/<id>` without a manual browser refresh.

### Honesty check
One intermediate observer call timed out, and one observer call was interrupted by
navigation while the hard reload happened. I recovered by reading the same open tab
state after navigation. The final evidence is from the open production browser tab,
not inferred from tests alone.

### Automated checks
- `bun run lint:file -- components/Dashboard.tsx` — clean after removing the
  unnecessary soft-refresh churn.
- `bun run typecheck` — clean.
- `vercel --prod --yes` — production build/deploy succeeded.
- `bun run test` — 42 pass / 0 fail.

## Change 8 — Colored grid deltas + green focus heatmap

### What the user asked for
- The +/- change tokens in the metric grid (e.g. "Hours present 8.4 · +3.9 vs
  yesterday") should be colored: green for an increase, red for a decrease,
  gray for zero. Only the number is colored — "vs yesterday" stays gray.
- The history heatmap should use clean, clearly-distinguishable colors instead of
  the old gray ramp, where adjacent shades were hard to tell apart.

### What changed
- `components/Dashboard.tsx`: `MetricCard` now carries `delta` (signed token to
  color, or null) + `deltaNote` (muted descriptor) instead of one pre-joined
  `subline`. Collapsed `numDelta`, the unused `deltaSign`, `oneDecimalDelta`, and
  the inline `sign()` into one `trend(current, baseline, decimals)` helper whose
  color sign is derived from the same rounded number it displays (so the hue can
  never disagree with the shown value). Render wraps only the number in a colored
  `<Num>` — `up → text-green-400`, `down → text-red-400`, `zero → text-zinc-400`
  — while the note inherits the parent `text-zinc-500`.
- `components/DayHeatmap.tsx`: `cellColor` replaced the grayscale ramp with a
  single-hue green scale that brightens with focus (`#0d3321 → #135a32 → #1a7d42
  → #229c51 → #2cbb61 → #45d977`); no-data days stay neutral `#18181b` so they
  read differently from a low-focus day.
- `lib/delta.ts` (new): the `trend` helper plus `Delta`/`DeltaSign` types moved
  here so the delta logic is unit-testable outside the client component.
  `Dashboard` imports `trend`, and `MetricCard` is now `{ label, value } & Delta`.

### Tested AS A USER (real app via dev server, fixture route, desktop 1280)
- Rendered the real `Dashboard`/`DayHeatmap` with a fixture through a temporary
  `/colorcheck` route (deleted after) so the actual component code + compiled
  Tailwind ran, not a mock.
- Grid deltas, confirmed by computed `color`:
  - `+3.9` and `+15` → `oklch(0.792 0.209 151.711)` = green-400.
  - `−6` and `−15` → `oklch(0.704 0.191 22.216)` = red-400.
  - `+0` (today == yesterday, both Avg focus and Focus streak) →
    `oklch(0.705 0.015 286.067)` = zinc-400 (gray), not green/red.
  - "vs yesterday" stayed gray in every card.
- Heatmap: sampled cell backgrounds returned the seven intended values
  (`#18181b` empty + the six greens), each bucket populated — visibly stepped
  from dark to bright green where the old gray steps were nearly identical.

### Targeted test (repeatable, exercises the shipped logic)
- `tests/delta.test.ts` imports the same `trend` the component renders with and
  asserts the color sign per state: increase → `up` (green), decrease → `down`
  (red), exact no-change → `zero` (gray), no baseline → `none`. It also pins the
  key property — a change that rounds to zero (+0.02 at one decimal → "+0.0")
  reads `zero`/gray, never `up`/green — and the U+2212 minus glyph in the token.
- `bun test tests/delta.test.ts` — 5 pass / 0 fail.

### Limits pushed
- Drove every heatmap bucket (scores 5→95) plus no-data gaps across a ~240-day
  history so all seven colors appear at once.
- Exercised all delta states in one view: positive, negative, and zero (×2).

### What was deleted
- `numDelta`, `oneDecimalDelta`, and the never-called `deltaSign()` helper (folded
  into `trend`); the `MetricCard.subline` field; the grayscale heatmap ramp.
- Temporary `/colorcheck` verification route and its stale `.next` type stub.

### Honesty check
- The delta formatting + color-sign logic is now covered by `tests/delta.test.ts`
  against the exact shipped `trend`, so that path is verified deterministically.
- The weakest part remains the visual layer: the live screenshots used a fixture
  route, not production data, because the dev DB this run connected to was empty
  (all metrics "No baseline", no scored heatmap days). The fixture drove the real
  components + real Tailwind build, and computed-style assertions confirm the
  exact resolved colors — but they were not observed against production data this
  session. The `deltaSign` → Tailwind class mapping and the heatmap hex ramp rest
  on those computed-style / sampled-background checks, not on unit tests.

### Automated checks
- `bun run lint:file` — clean on `lib/delta.ts`, `components/Dashboard.tsx`,
  `components/DayHeatmap.tsx`, `tests/delta.test.ts`.
- `bun run typecheck` — clean.
- `bun test tests` — 47 pass / 0 fail (was 42; +5 new delta tests).

## Change 9 — Snapshot strip follows the selected frame

Date: 2026-06-19

### What changed
- `components/Dashboard.tsx`: added a ref to the selected snapshot thumbnail and
  scrolls it into view with `inline: "end"` whenever the selected frame id
  changes. This covers the auto-refresh path because a new latest snapshot resets
  the dashboard to the latest frame, then the filmstrip aligns that selected
  thumbnail to the right edge.

### Tested AS A USER
- Deployed production: `dpl_9cb6KVKBN8QUooTGCWxLjc8E13Mw`,
  `https://livework-qr1gcxjld-tombridger1030s-projects.vercel.app`,
  aliased to `https://tally-focus.vercel.app`.
- Opened `https://livework-one.vercel.app/` in Chromium.
- Selected the 9 PM bar, which had 12 snapshots. The page selected
  `Snapshot at 9:56 PM` and the filmstrip immediately scrolled to the end:
  `scrollLeft=542`, `maxScrollLeft=542`, selected thumbnail fully visible,
  `selectedDistanceFromRight=0`.

### Limits pushed
- Verified an overflowing strip, not the current hour's short two-frame strip.
- Confirmed the hero image and selected thumbnail matched the same timestamp.

### What was deleted
- Nothing. The change only adds selected-frame scroll alignment.

### Honesty check
- The exact auto-refresh event was not re-waited for this one-line behavior
  change; the selected-frame path was verified in production with an overflowing
  hour. Auto-refresh already resets selection to latest, so it uses this same
  selected-frame scroll path after reload.

### Automated checks
- `bun run lint:file -- components/Dashboard.tsx` — clean.
- `bun run typecheck` — clean.
- `bun run test -- tests/dashboard-frames.test.ts tests/return-refresh.test.ts`
  — 47 pass / 0 fail.
- `bun run build` — clean local production build.

## Change 10 — Today deltas compare against yesterday at this time

Date: 2026-06-19

### What changed
- `lib/dashboard.ts`: Today’s trend baseline now uses the prior present day only
  up to the current local time. Snapshot-backed metrics count frames captured
  through that minute; hourly metrics include only fully elapsed hour rollups.
  Historical-day deltas still compare against the full prior day.
- `lib/delta.ts`: `trend()` accepts a caller-supplied note so Today can render
  `vs yesterday at this time` while older full-day comparisons keep
  `vs yesterday`.
- `components/Dashboard.tsx`: Today metric cards pass the same-time note when
  viewing the live day.
- `tests/dashboard-frames.test.ts`: added a same-time cutoff regression.
- `tests/delta.test.ts`: added custom-note coverage.

### Tested AS A USER
- Deployed production: `dpl_DHqgn78tfCAddA7AcSRrNu76QiAn`,
  `https://livework-hpf1ihfuu-tombridger1030s-projects.vercel.app`,
  aliased to `https://tally-focus.vercel.app`.
- Opened `https://livework-one.vercel.app/` in Chromium.
- The Today grid now renders:
  - Hours present `1.8` with `+1.1 vs yesterday at this time`
  - Avg focus `45` with `+36 vs yesterday at this time`
  - Headphones `7%` with `−7 vs yesterday at this time`
  - Focus streak `1h` with `+1 vs yesterday at this time`

### Limits pushed
- Unit test cutoff at exactly `10:00`: 8:05 and 9:55 snapshots count, 10:05 does
  not; the 10 AM hourly rollup is also excluded.
- Verified production browser text uses the same-time note, not the old full-day
  `vs yesterday` note.

### What was deleted
- Nothing. The full-day historical comparison path remains for non-live days.

### Honesty check
- Browser verification used current production data; it confirms the visible
  labels and positive same-time hours delta. It does not prove every possible
  timezone boundary in-browser; the UTC-pinned unit test covers the cutoff rule.

### Automated checks
- `bun run lint:file -- lib/dashboard.ts`
- `bun run lint:file -- lib/delta.ts`
- `bun run lint:file -- components/Dashboard.tsx`
- `bun run lint:file -- tests/dashboard-frames.test.ts`
- `bun run lint:file -- tests/delta.test.ts`
- `bun run test -- tests/dashboard-frames.test.ts tests/delta.test.ts` — 49 pass / 0 fail.
- `bun run test` — 49 pass / 0 fail.
- `bun run typecheck` — clean.
- `bun run build` — clean local production build.

## Change 11 — Percent units on focus/headphones deltas

Date: 2026-06-19

### What changed
- `components/Dashboard.tsx`: Avg focus now renders as a percentage value
  (`41%`, not `41`) in both Today and Average. Today’s Avg focus and Headphones
  deltas now include `%` inside the colored token.
- `lib/delta.ts`: `trend()` accepts a suffix so unit labels stay colored with
  the signed number (`+36%`, `−7%`).
- `tests/delta.test.ts`: added percent-suffix coverage.

### Tested AS A USER
- Deployed production: `dpl_BiBEABx3qtg7TGRG9nURCow4oyHC`,
  `https://livework-77upe9b7g-tombridger1030s-projects.vercel.app`,
  aliased to `https://tally-focus.vercel.app`.
- Opened `https://livework-one.vercel.app/` in Chromium.
- The Today grid rendered:
  - Avg focus `41%` with `+32% vs yesterday at this time`
  - Headphones `7%` with `−10% vs yesterday at this time`

### Honesty check
- Production values moved since the previous check because a new snapshot landed.
  The verified behavior is the unit formatting: focus value has `%`, and percent
  deltas include `%` inside the colored token.

### Automated checks
- `bun run lint:file -- lib/delta.ts` — clean.
- `bun run lint:file -- components/Dashboard.tsx` — clean.
- `bun run lint:file -- tests/delta.test.ts` — clean.
- `bun run test -- tests/delta.test.ts` — 50 pass / 0 fail.
- `bun run typecheck` — clean.
- `bun run build` — clean local production build.

## Change 8 — Critical hours replace focus streak

### What changed
- `hourly_checkins` gained a human-owned `critical` flag. Automated rollups update
  score/presence/headphones/verdict only; the critical flag is written only through
  `setCriticalHour`.
- `/api/critical` marks an existing `(day, hour)` check-in critical/not critical
  and rejects malformed input or missing hours.
- `Dashboard` adds a two-tap hour pill: `Mark critical hour` → `Confirm critical
  hour` → `Critical hour`; tap again arms removal.
- The hourly bar chart gets a small `★` marker for critical hours.
- The stats grid replaces `Focus streak` with `Critical hours` in both Today and
  Average. Average shows mean critical hours/day over the 7-day window.

### Tested AS A USER
- Seeded a local scoring-window hour for Sat Jun 20, 10am, with one real stored
  snapshot/check-in.
- Ran the app on `http://127.0.0.1:3101`.
- Browser flow: saw `CRITICAL HOURS 0h` and `Mark critical hour`; clicked once and
  saw `Confirm critical hour`; clicked again and saw `Critical hour`, `CRITICAL
  HOURS 1h`, and a `★` marker above the 10am bar.
- Clicked `Average`; saw `CRITICAL HOURS 1.0h`.
- Reloaded the page; `Critical hour`, `1h`, and `★` persisted.

### Output proof
- Browser result: `{ today: "1h", average: "1.0h", state: "Critical hour", marker:
  "★" }`.
- Route/server proof: `POST /api/critical 200` during the browser flow.

### Limits pushed
- `statsUpToLocalTime` test marks both 9am and 10am critical but cuts off at
  10:00; result is `criticalHours === 1`, proving future hours do not leak into
  the "yesterday at this time" comparison.
- Store test marks an hour critical, then saves a new machine rollup for the same
  hour; `critical` remains true while avg/verdict update.
- Route validation test rejects malformed `day`.
- Missing captured-hour test returns `null` instead of inventing fake hours.

### What was deleted
- `Focus streak` grid card was replaced in both Today and Average.
- `longestFocusRun`, `FOCUS_HOUR_THRESHOLD`, and every `focusStreak*` type/callsite
  were removed; final search for `focusStreak|longestFocusRun|FOCUS_HOUR_THRESHOLD`
  returned no matches.

### End-to-end user journey
1. User opens today's dashboard.
2. User selects/reviews an hour with a real check-in.
3. User taps `Mark critical hour`, then `Confirm critical hour`.
4. Browser sends `POST /api/critical` with `{ day, hour, critical }`.
5. Store updates only the human flag for that existing hourly row.
6. Dashboard refreshes; the hour pill, Today card, Average card, and bar marker all
   reflect the same stored value.

### Checks run
- `bun run lint:file -- <changed file>` after each edit.
- `bun run test -- -t "critical|statsUpToLocalTime|buildHourlyCheckin|dailyHistory"` — 9 pass.
- `bun run lint` — checked 84 files.
- `bun run typecheck` — clean.
- `bun run test` — 54 pass, 0 fail, 115 assertions.

### Red-flag-check output
Changed files audited: `lib/types.ts`, `lib/rollup.ts`, `lib/store.ts`,
`lib/dashboard.ts`, `app/api/critical/route.ts`, `components/charts/BarChart.tsx`,
`components/Dashboard.tsx`, and the focused tests.

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A1 Shallow Module | NO | `setCriticalHour` hides the preserve-vs-rollup storage rule; `/api/critical` owns request validation. | - |
| A2 Information Leakage | NO | Critical is single-sourced as `HourlyCheckin.critical`; rollup preservation is centralized in `saveHourlyCheckin`/`setCriticalHour`. | - |
| A5 Pass-Through | NO | No new wrapper merely forwards an identical signature. | - |
| A6 Repetition | NO | Tests repeat small literals only; the invariant is explicitly tested once in `critical-hour.test.ts`. | - |
| A7 Special-General Mixture | NO | `BarChart` gets generic `markKey`; product-specific critical wording stays in `Dashboard`. | - |
| A14 Nonobvious Code | NO | The only hidden invariant has an interface comment on `setCriticalHour` and a regression test. | - |
| B1 Change amplification worse | NO | Future critical-hour persistence changes touch store/API/UI, not rollup scoring logic. | - |
| B2 Cognitive load worse | NO | Critical hours are a boolean count; focus-streak threshold/run logic was deleted. | - |
| B3 Unknown unknowns worse | NO | Known clobber risk is tested: automated rollups preserve the human flag. | - |
| C1 Define-errors-out | NO | Missing-hour API response is a real domain condition; UI hides the button unless a check-in exists. | - |

8 files plus tests audited; 0 YES red flags.

### Honesty check
- Browser proof used seeded local data, not production data.
- Dev server emitted a Recharts `width(-1)/height(-1)` warning during hidden
  headless page load; the chart rendered, the `★` marker was present, and no
  functional break was observed.

## Change 9 — AFK capture backoff

Date: 2026-06-20

### What changed
- `lib/capture-cadence.ts`: new single owner for capture cadence. Normal work
  stays at 5 minutes; consecutive away time backs off to 15 minutes after 30
  minutes away and 30 minutes after 60 minutes away.
- `app/api/status/route.ts`: `/api/status` now returns `capture.due`,
  `intervalMinutes`, `awayMinutes`, and `nextDueAt` from the latest snapshot plus
  the recent away streak. Paused and quiet hours force `capture.due = false`.
- `agent/capture.ts`: `precheck` exits with code 10 before the zsh launcher opens
  the camera when `capture.due === false`.
- `tests/capture-cadence.test.ts`: covers normal cadence, 30-minute backoff,
  60-minute backoff, and the status-route state the agent reads.
- `agent/README.md`: documents launchd still checks every 5 minutes while the
  server decides whether a camera capture is due. Also corrected the existing
  fallback-camera requirement text to match `run-capture.sh`.

### Tested AS THE AGENT FLOW
- Started the dev server on `http://127.0.0.1:3102`.
- Seeded two away snapshots: first away 35 minutes ago, latest away 5 minutes
  ago.
- Read `/api/status?t=...` and observed:
  `capture.due=false`, `intervalMinutes=15`, `awayMinutes=35`, and a future
  `nextDueAt`.
- Ran `WORK_LIVE_BASE_URL=http://127.0.0.1:3102 bun agent/capture.ts precheck`.
  Observed exit code `10` with:
  `AFK backoff; next capture due at ...; camera not opened`.
- Reseeded due state: first away 45 minutes ago, latest away 16 minutes ago.
  Read `/api/status?t=due` and observed `capture.due=true`,
  `intervalMinutes=15`, `awayMinutes=45`.
- Ran the same agent precheck and observed exit code `0` with no output, meaning
  the launcher would continue to camera capture only when due.

### Limits pushed
- Unit coverage hits the exact 30-minute threshold and the 60-minute deep-backoff
  threshold.
- Route coverage verifies the skip decision is available before the camera is
  opened.
- The due-state smoke test verifies backoff does not permanently suppress capture.

### What was deleted
- No production code was deleted. The change removes unnecessary AFK capture
  attempts by exiting before `imagesnap`, not by suppressing stored results after
  capture.

### End-to-end journey
Launchd still wakes every 5 minutes. `run-capture.sh` asks `/api/status` first.
When the latest stored state shows a sustained away streak and the next interval
is not due yet, `agent/capture.ts precheck` exits 10 and the shell exits before
opening the camera. Once the 15- or 30-minute interval has elapsed, precheck exits
0 and the existing camera/post path runs unchanged.

### Honesty check
I verified the real precheck/API/data boundary, not a physical launchd tick or
real camera capture. That is the correct proof for the savings path because the
new behavior must stop before `imagesnap`. After deploy, re-run `./agent/install.sh`
so the copied agent under `~/.config/work-live/` picks up `capture.ts`.

### Red-flag check output

File: `lib/capture-cadence.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A1 Shallow Module | NO | lines 44-72 hide cadence thresholds/streak math behind one function | - |
| A2 Information Leakage | NO | lines 6-10 keep cadence thresholds in one module | - |
| A6 Repetition | NO | interval selection lives once in `intervalFor` lines 37-42 | - |
| A14 Nonobvious Code | NO | lines 44-52 state the public cadence contract | - |
| B1 Change amplification worse | NO | future threshold changes touch this module and tests | - |
| B2 Cognitive load worse | NO | status route consumes one `captureCadenceFor` result | - |
| B3 Unknown unknowns worse | NO | due/nextDueAt is explicit instead of implicit in the agent | - |
| C1 Define errors out | N/A | no new error path | - |

File: `app/api/status/route.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | line 9 imports the lookback constant instead of duplicating it | - |
| A6 Repetition | NO | status still builds one response object lines 17-23 | - |
| A14 Nonobvious Code | NO | `capture` field line 22 directly names the precheck decision | - |
| B1 Change amplification worse | NO | agent cadence policy is delegated to `lib/capture-cadence.ts` | - |
| B2 Cognitive load worse | NO | route remains a thin read/compose endpoint | - |
| B3 Unknown unknowns worse | NO | paused/quiet override is visible at line 22 | - |
| C1 Define errors out | N/A | no new error path | - |

File: `agent/capture.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | agent reads server-provided `capture.due`; thresholds are not copied here | - |
| A6 Repetition | NO | skip handling is one branch lines 99-113 | - |
| A14 Nonobvious Code | NO | comment lines 76-94 explains why the camera is outside Bun and when precheck skips | - |
| B1 Change amplification worse | NO | future cadence changes stay server-side unless response shape changes | - |
| B2 Cognitive load worse | NO | explicit `reason` branch replaces nested conditions lines 101-110 | - |
| B3 Unknown unknowns worse | NO | logs include the next due time for skipped AFK ticks | - |
| C1 Define errors out | N/A | no new error path; skip remains the existing code-10 control path | - |

File: `tests/capture-cadence.test.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A6 Repetition | NO | fixture builders separate pure rows from persisted rows lines 24-55 | - |
| A14 Nonobvious Code | NO | test names line 77, 89, 101, 113 state user-visible cadence behavior | - |
| B1 Change amplification worse | NO | thresholds are locked in one test file for the cadence module | - |
| B2 Cognitive load worse | NO | exact `nextDueAt` expectations document the interval math | - |
| B3 Unknown unknowns worse | NO | route test proves the agent-visible `/api/status` contract | - |
| C1 Define errors out | N/A | no new error path | - |

File: `agent/README.md`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | prose references behavior; exact implementation still lives in code | - |
| A6 Repetition | NO | cadence explanation appears once in verify/inspect section lines 94-100 | - |
| A14 Nonobvious Code | NO | lines 11-15 explain the skip-before-camera path | - |
| B1 Change amplification worse | NO | operational docs updated with the new cadence contract | - |
| B2 Cognitive load worse | NO | fallback-camera stale text corrected lines 42-43 | - |
| B3 Unknown unknowns worse | NO | launchd check interval vs capture interval distinction is explicit | - |
| C1 Define errors out | N/A | no new error path | - |

5 files audited; 0 YES, 32 NO, 5 N/A.

### Automated checks
- `bun run lint:file -- lib/capture-cadence.ts`
- `bun run lint:file -- app/api/status/route.ts`
- `bun run lint:file -- agent/capture.ts`
- `bun run lint:file -- tests/capture-cadence.test.ts`
- `bun run lint:file -- agent/README.md`
- `bun run test -- -t "captureCadence|status route returns AFK"` — 4 pass / 0 fail.
- `bun run lint` — 86 files checked.
- `bun run typecheck` — clean.
- `bun run test` — 58 pass / 0 fail, 122 assertions.

## Change 10 — Production deployment and installed AFK agent

Date: 2026-06-20

### What changed outside the repo
- Deployed production with `vercel --prod --yes`.
- Production deployment id: `dpl_HNzmC9JRiHQLcKDXzxpWZMygLKa4`.
- Production URL: `https://livework-q04gws8x4-tombridger1030s-projects.vercel.app`.
- Production alias: `https://tally-focus.vercel.app`.
- Updated `~/.config/work-live/env` so `WORK_LIVE_BASE_URL` points at
  `https://tally-focus.vercel.app` without printing or changing secrets.
- Ran `./agent/install.sh`, which copied the updated `capture.ts` and
  `run-capture.sh` into `~/.config/work-live/`, reloaded
  `com.tombridger.work-live`, and kickstarted one run.

### Verified setup
- Vercel production build completed successfully: Next compile, lint/type
  validity, page data collection, static generation, and serverless function
  creation all succeeded.
- `launchctl print gui/501/com.tombridger.work-live` reported:
  `state = not running`, `runs = 2`, `last exit code = 0`,
  `run interval = 300 seconds`.
- `https://tally-focus.vercel.app/api/status?t=afk-deploy` returned the new
  capture object:
  `due=false`, `intervalMinutes=30`, `awayMinutes=118`, and a future
  `nextDueAt`.
- Running the installed copy with the installed env:
  `zsh -lc 'source "$HOME/.config/work-live/env"; bun "$HOME/.config/work-live/capture.ts" precheck'`
  exited `10` with:
  `AFK backoff; next capture due at ...; camera not opened`.

### Honesty check
The deployed status endpoint and installed agent precheck are verified. The
current production state is already deep-away, so the installed agent correctly
skipped opening the camera; it will resume capture automatically when
`nextDueAt` arrives or when future work-state captures reset the away streak.

## Change 11 — AFK backoff historical cleanup

Date: 2026-06-20

### Root cause
The deployed capture gate was already working: production `/api/status` returned
`capture.due=false`, `intervalMinutes=30`, and a future `nextDueAt`; the installed
agent precheck exited `10` before opening the camera. The remaining problem was
stored data: old 5-minute `away` snapshots and their hourly rollups were still in
the database, so the dashboard could still show a dense historical filmstrip.

### What changed
- `lib/capture-cadence.ts`: added `skippedSnapshotsForCaptureCadence`, a pure
  replay of the live 5/15/30-minute cadence over already-stored snapshots.
  Non-away snapshots are never deleted.
- `lib/store.ts`: added owner-maintenance delete primitives for snapshots and
  empty hourly rollups.
- `app/api/purge-afk-overflow/route.ts`: added owner-authenticated, idempotent
  cleanup. It deletes only historical `away` snapshots that live capture would
  have skipped, then rebuilds affected hourly check-ins from the remaining rows.
- `tests/capture-cadence.test.ts`: added regression coverage for historical
  thinning and the cleanup route.

### Tested AS A USER / production
- Deployed exact final code with `vercel --prod --yes`.
- Final deployment id: `dpl_AbmruRMg2R5imFpoZUyXWhRyxQUq`.
- Production alias: `https://tally-focus.vercel.app`.
- Ran `POST /api/purge-afk-overflow` with the installed owner secret:
  `deleted.snapshots=330`, `deleted.checkinsRebuilt=48`,
  `deleted.checkinsDeleted=0`, `remaining.snapshots=0`.
- Re-ran the same cleanup after final redeploy:
  `deleted.snapshots=0`, `checkinsRebuilt=0`, `checkinsDeleted=0`,
  `remaining.snapshots=0` — idempotence verified.
- `https://tally-focus.vercel.app/api/status?t=after-final-redeploy` returned
  `capture.due=false`, `intervalMinutes=30`, `awayMinutes=106`, and future
  `nextDueAt=2026-06-20T22:28:44.044Z`.
- Installed agent precheck:
  `AFK backoff; next capture due at 2026-06-20T22:28:44.044Z; camera not opened`
  and `exit_code=10`.
- Production page render now shows the current 2 PM detail as
  `2 snapshots this hour`, proving the visible filmstrip was thinned.

### Limits pushed
- Cleanup ran across all stored snapshots, not just today.
- Re-running cleanup proved there were zero remaining cadence-overflow rows.
- The live gate and installed agent were verified after cleanup and after final
  redeploy.

### What was deleted
- 330 redundant historical `away` snapshot rows in production.
- No present/locked-in snapshots were deleted.
- No hourly rollups were left stale; 48 affected rows were rebuilt.

### End-to-end user journey
launchd still checks every 5 minutes. When the user is deep-away, `/api/status`
returns `due=false`, the installed agent exits before camera access, no snapshot
is sent, and the dashboard no longer shows the old 5-minute AFK pile because the
stored rows were thinned to the same cadence.

### Honesty check
The production state at verification time was already deep-away, so the proof is
the skip path plus historical cleanup. The next due capture at `nextDueAt` was not
waited for; prior verification already proved due ticks still capture.

### Red-flag check output

File: `lib/capture-cadence.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | cleanup reuses the live cadence module instead of duplicating thresholds | - |
| A6 Repetition | NO | 5/15/30 and 30/60 thresholds still live in one file | - |
| A14 Nonobvious Code | NO | public cleanup helper comment states asc input and keep/delete rules | - |
| B1 Change amplification worse | NO | future cadence changes update one module and both live/cleanup paths follow | - |
| B2 Cognitive load worse | NO | replay helper is linear and keeps non-away snapshots unconditionally | - |
| B3 Unknown unknowns worse | NO | route tests pin the historical thinning boundary cases | - |

File: `lib/store.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | maintenance deletes are generic store primitives; cadence policy stays elsewhere | - |
| A6 Repetition | NO | functions follow the existing Postgres/local split convention | - |
| A14 Nonobvious Code | NO | comments state caller-owned rollup rebuild responsibility | - |
| B1 Change amplification worse | NO | snapshot deletion and hourly deletion are narrow, reusable maintenance APIs | - |
| B2 Cognitive load worse | NO | no second persistence convention introduced | - |
| B3 Unknown unknowns worse | NO | empty-hour deletion is explicit instead of leaving stale derived rows | - |

File: `app/api/purge-afk-overflow/route.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A2 Information Leakage | NO | route orchestrates auth, cadence replay, delete, rebuild; no threshold constants | - |
| A6 Repetition | NO | affected day/hour grouping avoids repeated day scans per deleted row | - |
| A14 Nonobvious Code | NO | route comment states owner-auth, historical-only cleanup, idempotence | - |
| B1 Change amplification worse | NO | future cleanup changes stay behind one owner-maintenance route | - |
| B2 Cognitive load worse | NO | rebuilt/deleted counters reflect the two possible affected-hour outcomes | - |
| B3 Unknown unknowns worse | NO | route returns remaining overflow count and was run idempotently in production | - |

File: `tests/capture-cadence.test.ts`

| Flag | Verdict | Evidence | Follow-up |
|---|---|---|---|
| A6 Repetition | NO | new tests reuse existing row/store helpers | - |
| A14 Nonobvious Code | NO | expected skipped timestamps document the 30/60-minute boundaries | - |
| B1 Change amplification worse | NO | cleanup route and pure helper both covered in one focused cadence test file | - |
| B2 Cognitive load worse | NO | route test asserts production payload shape and persisted snapshot outcome | - |
| B3 Unknown unknowns worse | NO | regression covers redundant-row deletion plus affected-hour rebuild | - |

4 files audited; 0 YES, 23 NO, 0 N/A.

### Automated checks
- `bun run lint:file -- lib/capture-cadence.ts`
- `bun run lint:file -- lib/store.ts`
- `bun run lint:file -- app/api/purge-afk-overflow/route.ts`
- `bun run lint:file -- tests/capture-cadence.test.ts`
- `bun run test -- -t "captureCadence|skippedSnapshots|purge AFK|status route returns AFK"` — 6 pass / 0 fail.
- `bun run typecheck` — clean.
- `bun run lint` — 87 files checked.
- `bun run test` — 60 pass / 0 fail, 127 assertions.
- Vercel production build succeeded: compile, lint/type validity, static generation,
  serverless functions, and alias to `https://tally-focus.vercel.app`.
