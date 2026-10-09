# A usable deployed home during capture outages

## Problem

When today's archive document was missing, the deployed home rendered only
"Capture data is temporarily unavailable" and two links. Retained images and
history existed, but the page offered no way to browse them. A capture-device
failure therefore also made the dashboard unusable.

## Observable behavior

```text
Home -> today's archive exists -> today's dashboard
     -> today's archive absent -> latest retained day + explicit outage notice

Explicit date -> exact archive or missing-date message
Capture resumes -> home status poll sees new image -> today's dashboard
```

`readHomeMirror` selects a retained saved day only for the bare home route.
The result carries the missing date and requires the caller to display it.
Image dates, totals, publication timestamps, and the dashboard's selected date
remain historical. The existing exact-date reader and its tests are unchanged.
Historical date requests never substitute another date.

The home displays an amber notice stating that nothing has synced today and
identifying the saved date. History navigation, images, and the ledger remain
available. The notice gives the capture Mac/camera/drive checks. When home is
waiting for today, it reuses the existing status poll so a new published image
can reload the live view. Explicit historical views keep their previous polling
behavior.

The freshness notice now uses server-computed image/attempt ages before browser
hydration. Previously it used the old publication timestamp as "now", briefly
labeling an old image as synced/just captured on the first render.

## Verification and limits

Lint, typechecking, and all 270 tests passed. New tests verify identified fallback
without relabeling images/totals, exact missing dates, today's precedence, and
retention limits. Typechecking also passed after enabling home recovery polling.
The production build succeeded.

In the deployed browser, home displayed October 6 with the outage notice and a
loaded 512px image from `/mirror-assets/2026-10-06/…`. Previous-day navigation
opened `?day=2026-10-05`, displayed October 5, and loaded that date's own 512px
image. Returning home restored the explicitly identified saved-day view.
Screenshot: `docs/screenshots/tally-saved-day-outage-2026-10-07.png`.

This fixes dashboard availability during the outage. It does not restore image
capture. macOS still has no external physical drive and no NexiGo webcam.
Switching to the built-in camera/internal storage awaits the user's preference;
the capture configuration has not changed. Automatic recovery cannot be verified
with a real new capture until a camera and writable capture store are available.
