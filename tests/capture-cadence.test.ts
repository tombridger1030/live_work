import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GET as getStatus } from "@/app/api/status/route";
import { POST as purgeAfkOverflow } from "@/app/api/purge-afk-overflow/route";
import { captureCadenceFor, shouldStoreCaptureResult, skippedSnapshotsForCaptureCadence } from "@/lib/capture-cadence";
import type { CaptureCadence } from "@/lib/capture-cadence";
import { hourlyForDay, saveSnapshot, snapshotsForDay } from "@/lib/store";
import type { Signals, SnapshotRow } from "@/lib/types";

const thumbnail = new Uint8Array([1, 2, 3]);
let priorOwnerSecret: string | undefined;
let priorTimeZone: string | undefined;

function resetPostgresEnv(): void {
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL_NON_POOLING;
  delete process.env.POSTGRES_HOST;
}

async function resetStore(): Promise<void> {
  await rm(path.join(process.cwd(), ".work-live"), { recursive: true, force: true });
}

function snapshot(id: string, capturedAt: string, status: SnapshotRow["status"]): SnapshotRow {
  const present = status !== "away";
  return {
    id,
    capturedAt,
    present,
    headphones: present,
    eyesOnScreen: present,
    posture: present ? "upright" : "unknown",
    note: present ? "working" : "away",
    score: present ? 100 : 0,
    status,
    thumbUrl: `/api/thumb/${id}`
  };
}

async function saveStoredSnapshot(capturedAt: Date, status: SnapshotRow["status"]): Promise<void> {
  const present = status !== "away";
  const signals: Signals = {
    present,
    headphones: present,
    eyesOnScreen: present,
    posture: present ? "upright" : "unknown",
    note: present ? "working" : "away"
  };
  await saveSnapshot({
    capturedAt,
    signals,
    score: { score: present ? 100 : 0, status },
    thumbnail
  });
}

beforeEach(async () => {
  priorTimeZone = process.env.WORK_LIVE_TIME_ZONE;
  process.env.WORK_LIVE_TIME_ZONE = "UTC";
  resetPostgresEnv();
  await resetStore();
  priorOwnerSecret = process.env.OWNER_SECRET;
  process.env.OWNER_SECRET = "owner-secret";
});

function restoreEnv(): void {
  if (priorTimeZone === undefined) {
    delete process.env.WORK_LIVE_TIME_ZONE;
  } else {
    process.env.WORK_LIVE_TIME_ZONE = priorTimeZone;
  }
  if (priorOwnerSecret === undefined) {
    delete process.env.OWNER_SECRET;
  } else {
    process.env.OWNER_SECRET = priorOwnerSecret;
  }
}

afterEach(async () => {
  restoreEnv();
  await resetStore();
});

test("captureCadenceFor keeps normal cadence while working", () => {
  const now = new Date("2026-06-20T12:04:59.000Z");
  const latest = snapshot("latest", "2026-06-20T12:00:00.000Z", "locked_in");

  expect(captureCadenceFor(latest, [latest], now)).toEqual({
    due: false,
    intervalMinutes: 5,
    awayMinutes: null,
    nextDueAt: "2026-06-20T12:05:00.000Z"
  });
});

test("captureCadenceFor backs off after thirty consecutive away minutes", () => {
  const firstAway = snapshot("first-away", "2026-06-20T12:00:00.000Z", "away");
  const latest = snapshot("latest", "2026-06-20T12:30:00.000Z", "away");

  expect(captureCadenceFor(latest, [firstAway, latest], new Date("2026-06-20T12:35:00.000Z"))).toMatchObject({
    due: false,
    intervalMinutes: 15,
    awayMinutes: 35,
    nextDueAt: "2026-06-20T12:45:00.000Z"
  } satisfies Partial<CaptureCadence>);
});

test("captureCadenceFor waits thirty minutes after an hour away", () => {
  const firstAway = snapshot("first-away", "2026-06-20T12:00:00.000Z", "away");
  const latest = snapshot("latest", "2026-06-20T12:55:00.000Z", "away");

  expect(captureCadenceFor(latest, [firstAway, latest], new Date("2026-06-20T13:00:00.000Z"))).toMatchObject({
    due: false,
    intervalMinutes: 30,
    awayMinutes: 60,
    nextDueAt: "2026-06-20T13:25:00.000Z"
  } satisfies Partial<CaptureCadence>);
});

test("captureCadenceFor resets the away streak at the morning capture start", () => {
  const latest = snapshot("overnight-away", "2026-06-20T00:30:00.000Z", "away");

  expect(captureCadenceFor(latest, [latest], new Date("2026-06-20T08:05:00.000Z"))).toEqual({
    due: true,
    intervalMinutes: 5,
    awayMinutes: 5,
    nextDueAt: "2026-06-20T00:35:00.000Z"
  });
});

test("captureCadenceFor keeps an overnight streak intact before the quiet window", () => {
  const firstAway = snapshot("first-away", "2026-06-19T23:40:00.000Z", "away");
  const latest = snapshot("latest", "2026-06-20T00:25:00.000Z", "away");

  expect(captureCadenceFor(latest, [firstAway, latest], new Date("2026-06-20T00:30:00.000Z"))).toMatchObject({
    due: false,
    intervalMinutes: 15,
    awayMinutes: 50
  } satisfies Partial<CaptureCadence>);
});

test("captureCadenceFor still backs off for a streak accumulated within the same morning", () => {
  const firstAway = snapshot("first-away", "2026-06-20T08:20:00.000Z", "away");
  const middleAway = snapshot("middle-away", "2026-06-20T09:25:00.000Z", "away");
  const latest = snapshot("latest", "2026-06-20T09:30:00.000Z", "away");

  expect(captureCadenceFor(latest, [firstAway, middleAway, latest], new Date("2026-06-20T09:35:00.000Z"))).toMatchObject({
    intervalMinutes: 30,
    awayMinutes: 75
  } satisfies Partial<CaptureCadence>);
});

test("shouldStoreCaptureResult stores the first morning tick even when still away", () => {
  const latest = snapshot("overnight-away", "2026-06-20T00:30:00.000Z", "away");

  expect(shouldStoreCaptureResult(latest, [latest], "away", new Date("2026-06-20T08:05:00.000Z"))).toBe(true);
});
test("shouldStoreCaptureResult still stores a return-to-desk tick during AFK backoff", () => {
  const firstAway = snapshot("first-away", "2026-06-20T12:00:00.000Z", "away");
  const latest = snapshot("latest", "2026-06-20T12:55:00.000Z", "away");

  expect(shouldStoreCaptureResult(latest, [firstAway, latest], "locked_in", new Date("2026-06-20T13:00:00.000Z"))).toBe(true);
});

test("shouldStoreCaptureResult suppresses redundant away ticks between due samples", () => {
  const firstAway = snapshot("first-away", "2026-06-20T12:00:00.000Z", "away");
  const latest = snapshot("latest", "2026-06-20T12:55:00.000Z", "away");

  expect(shouldStoreCaptureResult(latest, [firstAway, latest], "away", new Date("2026-06-20T13:00:00.000Z"))).toBe(false);
});

test("status route reports AFK backoff state", async () => {
  const now = Date.now();
  await saveStoredSnapshot(new Date(now - 35 * 60_000), "away");
  await saveStoredSnapshot(new Date(now - 5 * 60_000), "away");

  const response = await getStatus();
  const body = (await response.json()) as { capture: CaptureCadence };

  expect(response.status).toBe(200);
  expect(body.capture.due).toBe(false);
  expect(body.capture.intervalMinutes).toBe(15);
  expect(body.capture.awayMinutes).toBeGreaterThanOrEqual(30);
});

test("skippedSnapshotsForCaptureCadence thins historical away runs", () => {
  const snapshots = Array.from({ length: 13 }, (_, index) =>
    snapshot(`away-${index}`, new Date(Date.UTC(2026, 5, 20, 12, index * 5)).toISOString(), "away")
  );

  expect(skippedSnapshotsForCaptureCadence(snapshots).map((row) => row.capturedAt)).toEqual([
    "2026-06-20T12:30:00.000Z",
    "2026-06-20T12:35:00.000Z",
    "2026-06-20T12:45:00.000Z",
    "2026-06-20T12:50:00.000Z",
    "2026-06-20T13:00:00.000Z"
  ]);
});

test("purge AFK overflow deletes redundant away snapshots and rebuilds affected hours", async () => {
  for (let index = 0; index < 13; index += 1) {
    await saveStoredSnapshot(new Date(Date.UTC(2026, 5, 20, 12, index * 5)), "away");
  }

  const response = await purgeAfkOverflow(
    new Request("http://localhost/api/purge-afk-overflow", {
      method: "POST",
      headers: { Authorization: "Bearer owner-secret" }
    })
  );
  const body = (await response.json()) as {
    deleted: { snapshots: number; checkinsRebuilt: number; checkinsDeleted: number };
    remaining: { snapshots: number };
  };

  expect(response.status).toBe(200);
  expect(body).toEqual({
    deleted: { snapshots: 5, checkinsRebuilt: 1, checkinsDeleted: 0 },
    remaining: { snapshots: 0 }
  });
  expect((await snapshotsForDay("2026-06-20")).map((row) => row.capturedAt)).toEqual([
    "2026-06-20T12:00:00.000Z",
    "2026-06-20T12:05:00.000Z",
    "2026-06-20T12:10:00.000Z",
    "2026-06-20T12:15:00.000Z",
    "2026-06-20T12:20:00.000Z",
    "2026-06-20T12:25:00.000Z",
    "2026-06-20T12:40:00.000Z",
    "2026-06-20T12:55:00.000Z"
  ]);
  expect(await hourlyForDay("2026-06-20")).toHaveLength(1);
});
