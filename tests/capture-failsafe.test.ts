import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { POST as markAwayWindow } from "@/app/api/purge-gaming/route";
import { frameClassificationPlanFor, needsStatusRunAudit } from "@/lib/capture-pipeline";
import { scoreFrom } from "@/lib/score";
import { hourlyForDay, saveSnapshot, snapshotsForDay } from "@/lib/store";
import type { Signals, SnapshotRow } from "@/lib/types";

const ownerSecret = "test-owner-secret";
const sameHash = "0000000000000000";
const changedHash = "ffffffffffffffff";

function row(id: string, capturedAt: string, status: SnapshotRow["status"], frameHash = sameHash): SnapshotRow {
  const present = status !== "away";
  return {
    id,
    capturedAt,
    present,
    headphones: present,
    eyesOnScreen: false,
    posture: present ? "upright" : "unknown",
    note: present ? "working" : "away",
    score: present ? 100 : 0,
    status,
    thumbUrl: `/api/thumb/${id}`,
    frameHash
  };
}

async function saveStoredSnapshot(id: string, capturedAt: string, signals: Signals): Promise<void> {
  await saveSnapshot({
    capturedAt: new Date(capturedAt),
    signals,
    score: scoreFrom(signals),
    thumbnail: new Uint8Array([1, 2, 3]),
    frameHash: id
  });
}

function presentSignals(note = "working"): Signals {
  return { present: true, headphones: true, eyesOnScreen: false, posture: "upright", note };
}

afterEach(async () => {
  delete process.env.OWNER_SECRET;
  if (existsSync(path.join(process.cwd(), ".work-live"))) {
    await rm(path.join(process.cwd(), ".work-live"), { force: true, recursive: true });
  }
});

test("frameClassificationPlanFor reuses only short unchanged runs", () => {
  const previous = row("previous", "2026-07-06T15:10:00.000Z", "locked_in");
  const recent = [row("start", "2026-07-06T15:00:00.000Z", "locked_in"), previous];

  expect(frameClassificationPlanFor(previous, recent, sameHash, new Date("2026-07-06T15:15:00.000Z"))).toBe("reuse_previous");
  expect(frameClassificationPlanFor(previous, recent, sameHash, new Date("2026-07-06T15:20:00.000Z"))).toBe("fresh_analysis");
});

test("frameClassificationPlanFor audits long unchanged runs", () => {
  const previous = row("previous", "2026-07-06T15:25:00.000Z", "locked_in");
  const recent = [
    row("start", "2026-07-06T15:00:00.000Z", "locked_in"),
    row("middle", "2026-07-06T15:15:00.000Z", "locked_in"),
    previous
  ];

  expect(frameClassificationPlanFor(previous, recent, sameHash, new Date("2026-07-06T15:30:00.000Z"))).toBe("presence_audit");
  expect(frameClassificationPlanFor(previous, recent, changedHash, new Date("2026-07-06T15:30:00.000Z"))).toBe("fresh_analysis");
});

test("needsStatusRunAudit catches hour-long same-status drift", () => {
  const previous = row("previous", "2026-07-06T15:55:00.000Z", "away");
  const recent = [
    row("start", "2026-07-06T15:00:00.000Z", "away"),
    row("middle", "2026-07-06T15:30:00.000Z", "away"),
    previous
  ];

  expect(needsStatusRunAudit(previous, recent, "away", new Date("2026-07-06T16:00:00.000Z"))).toBe(true);
  expect(needsStatusRunAudit(previous, recent, "locked_in", new Date("2026-07-06T16:00:00.000Z"))).toBe(false);
});

test("purge-gaming marks an owner-confirmed window away and rebuilds rollups", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  await saveStoredSnapshot("before", "2026-07-06T22:15:00.000Z", presentSignals("before window")); // 3:15pm PDT
  await saveStoredSnapshot("inside-15", "2026-07-06T22:25:00.000Z", presentSignals("bad present")); // 3:25pm PDT
  await saveStoredSnapshot("inside-19", "2026-07-07T02:05:00.000Z", presentSignals("bad present")); // 7:05pm PDT
  await saveStoredSnapshot("after", "2026-07-07T02:15:00.000Z", presentSignals("after window")); // 7:15pm PDT

  const response = await markAwayWindow(
    new Request("http://localhost/api/purge-gaming?day=2026-07-06&startHour=15&startMinute=20&endHour=19&endMinute=10", {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerSecret}` }
    })
  );
  const body = (await response.json()) as { rescored: { snapshots: number }; remaining: { nonAwaySnapshots: number } };
  const snapshots = await snapshotsForDay("2026-07-06");
  const checkins = await hourlyForDay("2026-07-06");

  expect(response.status).toBe(200);
  expect(body.rescored.snapshots).toBe(2);
  expect(body.remaining.nonAwaySnapshots).toBe(0);
  expect(snapshots.find((snapshot) => snapshot.note === "before window")?.present).toBe(true);
  expect(snapshots.find((snapshot) => snapshot.note === "Away — owner-confirmed absence from desk.")?.present).toBe(false);
  expect(snapshots.find((snapshot) => snapshot.note === "after window")?.present).toBe(true);
  expect(checkins.find((checkin) => checkin.hour === 15)?.presentPct).toBe(50);
  expect(checkins.find((checkin) => checkin.hour === 19)?.presentPct).toBe(50);
});
