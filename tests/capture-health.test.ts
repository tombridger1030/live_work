import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  captureFreshnessFor,
  captureMonitorAction,
  emptyCaptureHealth,
  mergeCaptureHealthWithLatest,
  readCaptureHealth,
  recordCaptureFailure,
  recordCaptureImage,
} from "@/lib/capture-health";
import type { Settings } from "@/lib/types";

const testRoot = path.join(process.cwd(), ".work-live-capture-health-test");
const settings: Settings = {
  paused: false,
  blur: false,
  updatedAt: "2026-09-15T00:00:00.000Z",
  snoozeUntil: null,
  nudgeState: null,
};

beforeEach(async () => {
  process.env.WORK_LIVE_DATA_DIR = testRoot;
  process.env.WORK_LIVE_TIME_ZONE = "UTC";
  await rm(testRoot, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env.WORK_LIVE_DATA_DIR;
  delete process.env.WORK_LIVE_TIME_ZONE;
  await rm(testRoot, { recursive: true, force: true });
});

test("a recent image is healthy even when the mirror publication is unrelated", async () => {
  await recordCaptureImage("image-1", new Date("2026-09-15T12:00:00.000Z"));

  const health = await readCaptureHealth();
  expect(captureFreshnessFor(health, settings, new Date("2026-09-15T12:15:00.000Z"))).toMatchObject({
    expected: true,
    stale: false,
  });
});

test("an old image is stale even when the agent attempted recently", async () => {
  await recordCaptureImage("old-image", new Date("2026-09-15T11:00:00.000Z"));
  await recordCaptureFailure("camera_unavailable", "Webcam capture was unavailable", new Date("2026-09-15T12:15:00.000Z"));

  const health = await readCaptureHealth();
  expect(captureFreshnessFor(health, settings, new Date("2026-09-15T12:16:00.000Z"))).toMatchObject({
    stale: true,
    reason: "camera_unavailable",
    attemptAgeMinutes: 1,
    imageAgeMinutes: 76,
  });
});

test("paused and quiet periods do not become incidents", () => {
  const health = {
    ...emptyCaptureHealth(),
    lastAttemptAt: "2026-09-15T03:00:00.000Z",
    lastImageAt: "2026-09-15T03:00:00.000Z",
  };
  expect(captureFreshnessFor(health, { ...settings, paused: true }, new Date("2026-09-15T12:00:00.000Z")).stale).toBe(false);
  expect(captureFreshnessFor(health, settings, new Date("2026-09-15T03:10:00.000Z")).reason).toBe("quiet_hours");
});

test("legacy mirror health derives a prior-day image without calling it today", () => {
  const health = mergeCaptureHealthWithLatest(emptyCaptureHealth(), {
    id: "old",
    capturedAt: "2026-09-14T23:55:00.000Z",
    captureSource: "agent",
  });

  expect(health.lastImageId).toBe("old");
  expect(health.lastImageAt).toBe("2026-09-14T23:55:00.000Z");
});

test("capture incidents alert once and then emit one recovery", () => {
  const health = {
    ...emptyCaptureHealth(),
    lastAttemptAt: "2026-09-15T12:15:00.000Z",
    lastImageAt: "2026-09-15T11:00:00.000Z",
    lastFailure: "camera_unavailable" as const,
  };
  const freshness = captureFreshnessFor(health, settings, new Date("2026-09-15T12:16:00.000Z"));
  const first = captureMonitorAction(health, freshness, null);
  expect(first.kind).toBe("failure");
  if (first.kind !== "failure") throw new Error("expected failure action");
  expect(captureMonitorAction(health, freshness, { key: first.key, startedAt: "2026-09-15T12:16:00.000Z" })).toEqual({ kind: "none" });

  const recoveredHealth = { ...health, lastImageAt: "2026-09-15T12:16:00.000Z", lastFailure: null };
  const recovered = captureFreshnessFor(recoveredHealth, settings, new Date("2026-09-15T12:17:00.000Z"));
  expect(captureMonitorAction(recoveredHealth, recovered, { key: first.key, startedAt: "2026-09-15T12:16:00.000Z" })).toEqual({ kind: "recovery" });
});

test("health failure messages redact bearer material", async () => {
  await recordCaptureFailure("upload_failed", "Authorization: Bearer super-secret-value", new Date("2026-09-15T12:00:00.000Z"));
  const health = await readCaptureHealth();

  expect(health.lastFailureMessage).toBe("Authorization: Bearer [redacted]");
  expect(health.lastFailureMessage).not.toContain("super-secret-value");
});
