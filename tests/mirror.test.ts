import { expect, test } from "bun:test";

import type { DashboardData } from "@/lib/dashboard";
import { applyDashboardOverrides } from "@/lib/dashboard-overrides";
import { applyLedgerOverrides } from "@/lib/ledger-overrides";
import { assembleLedger, dayRange } from "@/lib/ledger";
import { buildMirrorDashboardCopy } from "@/lib/mirror";
import { buildHourlyCheckin } from "@/lib/rollup";
import type { LedgerEntry } from "@/lib/types";
import type { SnapshotRow } from "@/lib/types";

function snapshot(id: string): SnapshotRow {
  return {
    id,
    capturedAt: "2026-08-24T23:00:00.000Z",
    thumbUrl: `/api/thumb/${id}`,
    present: true,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "working",
    score: 100,
    status: "locked_in",
  };
}

test("mirror copy resolves ALL hours once per snapshot without embedding image bytes", async () => {
  const olderHour = snapshot("older-hour");
  const defaultHour = Array.from({ length: 13 }, (_, index) =>
    snapshot(`current-${index + 1}`),
  );
  const latest = defaultHour.at(-1)!;
  const data = {
    defaultHour: 16,
    latest,
    hourlyFrames: { 15: [olderHour], 16: defaultHour },
  } as unknown as DashboardData;
  const requestedIds: string[] = [];

  const copy = await buildMirrorDashboardCopy(data, async (id) => {
    requestedIds.push(id);
    return `/mirror-assets/2026-08-24/${id}`;
  });

  expect(requestedIds).toEqual(
    [olderHour, ...defaultHour].map((frame) => frame.id),
  );
  expect(copy.latest?.thumbUrl).toBe(
    "/mirror-assets/2026-08-24/current-13",
  );
  expect(copy.hourlyFrames[16]?.at(-1)?.thumbUrl).toBe(
    "/mirror-assets/2026-08-24/current-13",
  );
  expect(copy.hourlyFrames[16]?.[0]?.thumbUrl).toBe("/mirror-assets/2026-08-24/current-1");
  expect(copy.hourlyFrames[15]?.[0]?.thumbUrl).toBe("/mirror-assets/2026-08-24/older-hour");
  expect(JSON.stringify(copy)).not.toContain("data:image");
  expect(data.latest?.thumbUrl).toBe("/api/thumb/current-13");
});

test("mirror ledger overrides rebuild derived scores without mutating the snapshot", () => {
  const days = dayRange("2026-08-24", "2026-08-30");
  const entry: LedgerEntry = {
    day: "2026-08-25",
    reachouts: 1,
    featureDone: false,
    replies: 0,
    meetings: 0,
    commits: 2,
    merges: 1,
  };
  const base = assembleLedger(
    days,
    new Map([[entry.day, entry]]),
    new Map([[entry.day, 7]]),
    "2026-08-30",
    "2026-08-24",
  );

  const updated = applyLedgerOverrides(base, {
    days: { [entry.day]: { reachouts: 250, featureDone: true } },
    weeks: {},
  });

  expect(updated.days.find((day) => day.day === entry.day)?.dailyValue).toBe(87);
  expect(updated.weeks[0]?.reachouts).toBe(250);
  expect(updated.days.find((day) => day.day === entry.day)?.featureDone).toBe(true);
  expect(updated.weeks[0]?.commits).toBe(2);
  expect(base.days.find((day) => day.day === entry.day)?.reachouts).toBe(1);
});

test("a mirror weekly goal applies forward until a later mirror goal", () => {
  const days = dayRange("2026-08-24", "2026-09-06");
  const base = assembleLedger(
    days,
    new Map(),
    new Map(),
    "2026-09-06",
    "2026-08-24",
  );

  const updated = applyLedgerOverrides(base, {
    days: {},
    weeks: {
      "2026-08-24": { reachouts: 500, hours: 20 },
      "2026-09-07": { reachouts: 600, hours: 30 },
    },
  });

  expect(updated.weeks[0]?.reachoutsTarget).toBe(500);
  expect(updated.weeks[1]?.reachoutsTarget).toBe(500);
});

test("mirror dashboard corrections rebuild the visible hour and critical total", () => {
  const frame = snapshot("dashboard-frame");
  const hourly = buildHourlyCheckin("2026-08-24", 16, [frame]);
  const base = {
    viewDay: "2026-08-24",
    hourlyFrames: { 16: [frame] },
    hourly: [hourly],
    latest: frame,
  } as unknown as DashboardData;

  const updated = applyDashboardOverrides(base, {
    snapshots: { [frame.id]: { present: false, headphones: false } },
    critical: { "2026-08-24/16": true },
  });

  expect(updated.latest?.present).toBe(false);
  expect(updated.latest?.score).toBe(0);
  expect(updated.hourly[0]?.avgScore).toBe(0);
  expect(updated.hourly[0]?.critical).toBe(true);
  expect(updated.stats.criticalHours).toBe(1);
  expect(base.latest?.present).toBe(true);
});
