import { expect, test } from "bun:test";
import { publicStatusFor } from "@/lib/status";
import type { Settings, SnapshotRow } from "@/lib/types";

const settings: Settings = {
  paused: false,
  blur: false,
  updatedAt: "2026-06-14T12:00:00.000Z",
  snoozeUntil: null,
  nudgeState: null
};

const lockedInSnapshot: SnapshotRow = {
  id: "snapshot-1",
  capturedAt: "2026-06-14T10:00:00.000Z",
  present: true,
  headphones: true,
  eyesOnScreen: true,
  posture: "upright",
  note: "focused",
  score: 100,
  status: "locked_in",
  thumbUrl: "/api/thumb/snapshot-1"
};

test("publicStatusFor does not show locked in from stale data", () => {
  const result = publicStatusFor(lockedInSnapshot, settings, new Date("2026-06-14T11:00:00.000Z"));

  expect(result.displayStatus).toBe("no_recent_data");
  expect(result.stale).toBe(true);
});

test("publicStatusFor shows paused before stale or snapshot status", () => {
  const result = publicStatusFor(
    lockedInSnapshot,
    { ...settings, paused: true },
    new Date("2026-06-14T10:01:00.000Z")
  );

  expect(result.displayStatus).toBe("paused");
});
