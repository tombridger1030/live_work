import { expect, test } from "bun:test";
import { visionHealthFrom } from "@/lib/vision-health";
import { VISION_CREDITS_NOTE, VISION_UNAVAILABLE_NOTE } from "@/lib/vision";
import type { SnapshotRow } from "@/lib/types";

const now = new Date("2026-07-27T20:00:00.000Z");

function frame(minutesAgo: number, note: string, present = true): SnapshotRow {
  return {
    id: `s-${minutesAgo}`,
    capturedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    present,
    headphones: false,
    eyesOnScreen: false,
    posture: "unknown",
    score: 50,
    status: "present",
    note,
    thumbUrl: null,
  } as unknown as SnapshotRow;
}

test("a healthy run of real model reads reports ok", () => {
  const health = visionHealthFrom([frame(0, "Person at desk"), frame(5, "Person typing")], now);
  expect(health.status).toBe("ok");
  expect(health.failing).toBe(0);
});

// Credits never recover on their own, so one occurrence is enough to surface.
test("a single credits failure is reported immediately", () => {
  const health = visionHealthFrom([frame(0, VISION_CREDITS_NOTE), frame(5, "Person at desk")], now);
  expect(health.status).toBe("credits");
  expect(health.failing).toBe(1);
  expect(health.since).toBe(frame(0, "").capturedAt);
});

// A lone provider blip must NOT alarm — model failover exists precisely for that.
test("one generic failure is treated as noise", () => {
  const health = visionHealthFrom([frame(0, VISION_UNAVAILABLE_NOTE), frame(5, "Person at desk")], now);
  expect(health.status).toBe("ok");
  expect(health.failing).toBe(1);
});

test("three consecutive generic failures are a real outage", () => {
  const health = visionHealthFrom(
    [frame(0, VISION_UNAVAILABLE_NOTE), frame(5, VISION_UNAVAILABLE_NOTE), frame(10, VISION_UNAVAILABLE_NOTE), frame(15, "Person at desk")],
    now
  );
  expect(health.status).toBe("unavailable");
  expect(health.failing).toBe(3);
  expect(health.since).toBe(frame(10, "").capturedAt);
});

// The run must be CONSECUTIVE and current: an old outage that has since recovered
// is history, not a live alarm.
test("failures older than a successful read do not count", () => {
  const health = visionHealthFrom(
    [frame(0, "Person at desk"), frame(5, VISION_UNAVAILABLE_NOTE), frame(10, VISION_UNAVAILABLE_NOTE), frame(15, VISION_UNAVAILABLE_NOTE)],
    now
  );
  expect(health.status).toBe("ok");
  expect(health.failing).toBe(0);
});

// An empty desk asks the model nothing, so absent frames must never read as an outage.
test("away frames are ignored entirely", () => {
  const health = visionHealthFrom(
    [frame(0, "No person detected", false), frame(5, "No person detected", false), frame(10, "Person at desk")],
    now
  );
  expect(health.status).toBe("ok");
});

// Stale data says nothing about right now — the owner is just away.
test("an outage from hours ago is not reported as current", () => {
  const health = visionHealthFrom(
    [frame(180, VISION_CREDITS_NOTE), frame(185, VISION_CREDITS_NOTE), frame(190, VISION_CREDITS_NOTE)],
    now
  );
  expect(health.status).toBe("ok");
});

test("input order does not matter", () => {
  const frames = [frame(10, VISION_CREDITS_NOTE), frame(0, VISION_CREDITS_NOTE), frame(5, VISION_CREDITS_NOTE)];
  expect(visionHealthFrom(frames, now).status).toBe("credits");
  expect(visionHealthFrom([...frames].reverse(), now).status).toBe("credits");
});
