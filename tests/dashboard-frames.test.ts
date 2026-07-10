import { afterAll, beforeAll, expect, test } from "bun:test";
import { framesByHour, shouldReadViewDayUncached, statsUpToLocalTime } from "@/lib/dashboard";
import { frameStripRange, frameStripStartForSelection, shiftFrameStripWindow } from "@/lib/frame-strip";
import type { HourlyCheckin, SnapshotRow } from "@/lib/types";

// Pin the zone so capturedAt hours map straight to local hours in assertions.
// Set/restore inside hooks (not at module scope) so this never leaks into other
// test files that read the real clock against the timezone (e.g. quiet hours).
let priorTimeZone: string | undefined;
beforeAll(() => {
  priorTimeZone = process.env.WORK_LIVE_TIME_ZONE;
  process.env.WORK_LIVE_TIME_ZONE = "UTC";
});
afterAll(() => {
  if (priorTimeZone === undefined) {
    delete process.env.WORK_LIVE_TIME_ZONE;
  } else {
    process.env.WORK_LIVE_TIME_ZONE = priorTimeZone;
  }
});

function frame(id: string, capturedAt: string, score: number, present = true, headphones = false): SnapshotRow {
  return {
    id,
    capturedAt,
    present,
    headphones,
    eyesOnScreen: true,
    posture: "upright",
    note: "",
    score,
    status: present ? "present" : "away",
    thumbUrl: `/api/thumb/${id}`
  };
}

function checkin(day: string, hour: number, avgScore: number, critical = false): HourlyCheckin {
  return { day, hour, avgScore, presentPct: 100, headphonesPct: 0, verdict: "", critical };
}

test("framesByHour groups snapshots by local hour, preserving capture order", () => {
  const byHour = framesByHour([
    frame("a", "2026-06-16T11:05:00Z", 72),
    frame("b", "2026-06-16T11:25:00Z", 100),
    frame("c", "2026-06-16T11:55:00Z", 55),
    frame("d", "2026-06-16T12:10:00Z", 60)
  ]);

  expect(Object.keys(byHour)).toEqual(["11", "12"]);
  expect(byHour[11].map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  expect(byHour[11].map((entry) => entry.score)).toEqual([72, 100, 55]);
  expect(byHour[12].map((entry) => entry.id)).toEqual(["d"]);
});

test("framesByHour keeps every frame in an hour, not just the last", () => {
  // This is the invariant the hour-detail filmstrip depends on: the old code
  // collapsed each hour to one representative frame, hiding the rest.
  const byHour = framesByHour([
    frame("a", "2026-06-16T09:00:00Z", 10),
    frame("b", "2026-06-16T09:30:00Z", 90)
  ]);

  expect(byHour[9]).toHaveLength(2);
  expect(byHour[9].map((entry) => entry.score)).toEqual([10, 90]);
});
test("frameStripRange clamps the requested window to the available frames", () => {
  expect(frameStripRange(12, 0, 5)).toEqual({ start: 0, end: 5 });
  expect(frameStripRange(12, 7, 5)).toEqual({ start: 7, end: 12 });
  expect(frameStripRange(12, 9, 5)).toEqual({ start: 7, end: 12 });
});

test("frameStripStartForSelection biases toward the newest side of the strip", () => {
  expect(frameStripStartForSelection(12, 11, 5)).toBe(7);
  expect(frameStripStartForSelection(12, 3, 5)).toBe(0);
  expect(frameStripStartForSelection(5, 4, 5)).toBe(0);
});

test("shiftFrameStripWindow pages by whole visible sections", () => {
  expect(shiftFrameStripWindow(12, 7, 5, -1)).toBe(2);
  expect(shiftFrameStripWindow(12, 2, 5, -1)).toBe(0);
  expect(shiftFrameStripWindow(12, 2, 5, 1)).toBe(7);
  expect(shiftFrameStripWindow(8, 3, 5, -1)).toBe(0);
});

test("statsUpToLocalTime compares only through the current local minute", () => {
  const stats = statsUpToLocalTime(
    [
      frame("before-1", "2026-06-18T08:05:00Z", 80, true, true),
      frame("before-2", "2026-06-18T09:55:00Z", 90),
      frame("after", "2026-06-18T10:05:00Z", 20, true, true)
    ],
    [checkin("2026-06-18", 8, 80), checkin("2026-06-18", 9, 90, true), checkin("2026-06-18", 10, 20, true)],
    new Date("2026-06-19T10:00:00Z")
  );

  expect(stats.snapshots).toBe(2);
  expect(stats.hoursPresent).toBe(0.2);
  expect(stats.headphonesPct).toBe(50);
  expect(stats.avgScore).toBe(85);
  expect(stats.criticalHours).toBe(1);
});

test("live dashboard day bypasses cached snapshot/hourly reads", () => {
  expect(shouldReadViewDayUncached("2026-06-19", "2026-06-19")).toBe(true);
  expect(shouldReadViewDayUncached("2026-06-18", "2026-06-19")).toBe(false);
});
