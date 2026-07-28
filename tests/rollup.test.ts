import { expect, test } from "bun:test";
import { buildHourlyCheckin } from "@/lib/rollup";
import type { SnapshotRow } from "@/lib/types";

const snapshots: SnapshotRow[] = [
  {
    id: "a",
    capturedAt: "2026-06-14T10:05:00.000Z",
    present: true,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "focused",
    score: 100,
    status: "locked_in",
    thumbUrl: "/api/thumb/a"
  },
  {
    id: "b",
    capturedAt: "2026-06-14T10:35:00.000Z",
    present: true,
    headphones: false,
    eyesOnScreen: true,
    posture: "upright",
    note: "at desk",
    score: 30,
    status: "present",
    thumbUrl: "/api/thumb/b"
  }
];

test("buildHourlyCheckin summarizes an hour into one plain-English verdict", () => {
  const checkin = buildHourlyCheckin("2026-06-14", 10, snapshots);

  expect(checkin.avgScore).toBe(65);
  expect(checkin.presentPct).toBe(100);
  expect(checkin.headphonesPct).toBe(50);
  expect(checkin.verdict).toContain("At desk");
  expect(checkin.critical).toBe(false);
});

test("buildHourlyCheckin handles missing frames without inventing presence", () => {
  const checkin = buildHourlyCheckin("2026-06-14", 11, []);

  expect(checkin.avgScore).toBe(0);
  expect(checkin.presentPct).toBe(0);
  expect(checkin.verdict).toBe("No snapshots landed this hour.");
  expect(checkin.critical).toBe(false);
});

// The bug this exists to prevent: a frame no vision model examined stores
// `headphones: false` as a PLACEHOLDER, and counting it as an explicit "no"
// understated the real record by 8 focus and 12 headphone points across 415
// frames. Presence is still honest on those rows — local detection verified the
// desk — so only the model-derived numbers are excluded.
function frame(id: string, over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id,
    capturedAt: "2026-06-14T10:05:00.000Z",
    present: true,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "focused",
    score: 100,
    status: "locked_in",
    thumbUrl: `/api/thumb/${id}`,
    ...over
  } as SnapshotRow;
}

test("an unexamined frame is excluded from focus and headphone numbers", () => {
  const checkin = buildHourlyCheckin("2026-06-14", 10, [
    frame("seen"),
    frame("blind", { headphones: false, score: 30, status: "present", visionRead: "unknown" })
  ]);

  // headphonesPct excludes the unexamined frame entirely: 1 of 1 judged frames had
  // headphones. avgScore KEEPS it at its presence floor, so 100 and 30 average to
  // 65 — a lower bound, never an over-claim. Dropping it instead printed values
  // below the truth in 59 real hours.
  expect(checkin.headphonesPct).toBe(100);
  expect(checkin.avgScore).toBe(65);
  expect(checkin.unknownFrames).toBe(1);
  // Presence is NOT excluded: the detector genuinely saw him both times.
  expect(checkin.presentPct).toBe(100);
  expect(checkin.verdict).toContain("1 frame not examined");
});

test("a real no-headphones read still counts against the hour", () => {
  const checkin = buildHourlyCheckin("2026-06-14", 10, [
    frame("seen"),
    frame("no-hp", { headphones: false, score: 30, status: "present" })
  ]);

  expect(checkin.avgScore).toBe(65);
  expect(checkin.headphonesPct).toBe(50);
  expect(checkin.unknownFrames).toBe(0);
  expect(checkin.verdict).not.toContain("not examined");
});

// An hour where nothing was examined has no honest average. It must announce that
// rather than publishing a fabricated low score — this is the 2026-07-17 case,
// which read "30/100, 0% headphones" on zero observations.
test("an hour with no examined frames reports itself unmeasured", () => {
  const checkin = buildHourlyCheckin("2026-06-14", 10, [
    frame("b1", { headphones: false, score: 30, status: "present", visionRead: "unknown" }),
    frame("b2", { headphones: false, score: 30, status: "present", visionRead: "unknown" })
  ]);

  expect(checkin.unknownFrames).toBe(2);
  expect(checkin.presentPct).toBe(100);
  // The floor: both frames are known to be worth at least their presence score.
  expect(checkin.avgScore).toBe(30);
  expect(checkin.verdict).toContain("Not measured");
  expect(checkin.verdict).toContain("no frame was examined");
});
