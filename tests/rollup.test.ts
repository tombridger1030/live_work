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
