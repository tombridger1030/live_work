import { expect, test } from "bun:test";
import { createReturnRefresher, shouldReloadForLatestSnapshot } from "@/lib/return-refresh";

// A controllable clock + refresh counter so the throttle is tested deterministically.
function harness(throttleMs = 30_000) {
  let nowMs = 1_000_000;
  let refreshes = 0;
  const refresher = createReturnRefresher(
    () => {
      refreshes += 1;
    },
    { throttleMs, now: () => nowMs }
  );
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    refreshes: () => refreshes,
    refresher
  };
}

test("refreshes on visible, ignores hidden", () => {
  const h = harness();
  h.advance(60_000); // move past the throttle window opened at construction
  h.refresher.onVisibility("hidden");
  expect(h.refreshes()).toBe(0);
  h.refresher.onVisibility("visible");
  expect(h.refreshes()).toBe(1);
});

test("refreshes when the browser window regains focus", () => {
  const h = harness();
  h.advance(60_000);
  h.refresher.onFocus();
  expect(h.refreshes()).toBe(1);
});

test("does not refetch within the throttle window of load (SSR data still fresh)", () => {
  const h = harness();
  h.refresher.onVisibility("visible"); // 0ms since construction -> skipped
  expect(h.refreshes()).toBe(0);
  h.advance(29_999);
  h.refresher.onVisibility("visible"); // still inside the window -> skipped
  expect(h.refreshes()).toBe(0);
});

test("throttles rapid returns to once per window", () => {
  const h = harness(30_000);
  h.advance(30_000);
  h.refresher.onVisibility("visible"); // refresh #1
  h.refresher.onVisibility("visible"); // immediate repeat -> throttled
  h.advance(29_999);
  h.refresher.onVisibility("visible"); // still inside the window -> throttled
  expect(h.refreshes()).toBe(1);
  h.advance(1); // exactly throttleMs since the last refresh
  h.refresher.onVisibility("visible"); // refresh #2
  expect(h.refreshes()).toBe(2);
});

test("pageshow refreshes only on a bfcache restore (persisted)", () => {
  const h = harness();
  h.advance(60_000);
  h.refresher.onPageShow(false); // normal load -> ignored
  expect(h.refreshes()).toBe(0);
  h.refresher.onPageShow(true); // bfcache restore -> refresh
  expect(h.refreshes()).toBe(1);
});

test("visibility and pageshow share a single throttle", () => {
  const h = harness(30_000);
  h.advance(30_000);
  h.refresher.onVisibility("visible"); // refresh #1
  h.refresher.onPageShow(true); // same window via the shared throttle -> ignored
  expect(h.refreshes()).toBe(1);
  h.advance(30_000);
  h.refresher.onPageShow(true); // refresh #2
  expect(h.refreshes()).toBe(2);
});

test("focus and visibility share a single throttle", () => {
  const h = harness(30_000);
  h.advance(30_000);
  h.refresher.onFocus(); // refresh #1
  h.refresher.onVisibility("visible"); // same window via the shared throttle -> ignored
  expect(h.refreshes()).toBe(1);
  h.advance(30_000);
  h.refresher.onVisibility("visible"); // refresh #2
  expect(h.refreshes()).toBe(2);
});

test("reloads only when status latest snapshot is newer than rendered latest", () => {
  expect(shouldReloadForLatestSnapshot("old", "new")).toBe(true);
  expect(shouldReloadForLatestSnapshot(null, "new")).toBe(true);
  expect(shouldReloadForLatestSnapshot("same", "same")).toBe(false);
  expect(shouldReloadForLatestSnapshot("old", null)).toBe(false);
  expect(shouldReloadForLatestSnapshot(null, null)).toBe(false);
});
