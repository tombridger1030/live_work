import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { getOptionalEnv } from "@/lib/env";
import { buildHourlyCheckin } from "@/lib/rollup";
import {
  correctSnapshot,
  deleteHourlyCheckin,
  saveHourlyCheckin,
  snapshotsForDay,
} from "@/lib/store";
import { localDayKey, localHour } from "@/lib/time";
import type { ScoreResult, Signals, SnapshotRow } from "@/lib/types";

export const runtime = "nodejs";

function affectedHours(snapshots: SnapshotRow[]): Map<string, Set<number>> {
  const hoursByDay = new Map<string, Set<number>>();

  for (const snapshot of snapshots) {
    const capturedAt = new Date(snapshot.capturedAt);
    const day = localDayKey(capturedAt);
    const hour = localHour(capturedAt);
    const hours = hoursByDay.get(day) ?? new Set<number>();
    hours.add(hour);
    hoursByDay.set(day, hours);
  }

  return hoursByDay;
}

async function rebuildHours(hoursByDay: Map<string, Set<number>>): Promise<{ rebuilt: number; deleted: number }> {
  let rebuilt = 0;
  let deleted = 0;

  for (const [day, hours] of hoursByDay) {
    const daySnapshots = await snapshotsForDay(day);
    for (const hour of hours) {
      const hourSnapshots = daySnapshots.filter((snapshot) => localHour(new Date(snapshot.capturedAt)) === hour);
      if (hourSnapshots.length > 0) {
        await saveHourlyCheckin(buildHourlyCheckin(day, hour, hourSnapshots));
        rebuilt += 1;
      } else if (await deleteHourlyCheckin(day, hour)) {
        deleted += 1;
      }
    }
  }

  return { rebuilt, deleted };
}

/**
 * Owner-authenticated maintenance: rescores ALL snapshots in a time range as
 * away/not-present (webcam disconnected = gaming on PC, not working at Mac setup).
 * Rebuilds affected hours so the dashboard reflects actual presence.
 *
 * Query params:
 * - day: YYYY-MM-DD (default: yesterday)
 * - startHour: 0-23 (default: 17 = 5pm)
 * - startMinute: 0-59 (default: 23)
 * - endHour: 0-23 (default: 24 = midnight)
 * - endMinute: 0-59 (default: 0)
 *
 * Idempotent — re-running after rescoring updates nothing.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  const url = new URL(request.url);
  const params = url.searchParams;

  // Parse time range (default: yesterday 17:23 - 24:00)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const defaultDay = localDayKey(yesterday);

  const day = params.get("day") ?? defaultDay;
  const startHour = Number(params.get("startHour") ?? "17");
  const startMinute = Number(params.get("startMinute") ?? "23");
  const endHour = Number(params.get("endHour") ?? "24");
  const endMinute = Number(params.get("endMinute") ?? "0");

  const snapshots = await snapshotsForDay(day);

  // Filter: ALL snapshots in time range [startHour:startMinute, endHour:endMinute)
  const toRescore = snapshots.filter((snapshot) => {
    const capturedAt = new Date(snapshot.capturedAt);
    const hour = localHour(capturedAt);
    const minute = capturedAt.getMinutes();

    // Check if time is in range [start, end)
    const snapshotMinutes = hour * 60 + minute;
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    return snapshotMinutes >= startMinutes && snapshotMinutes < endMinutes;
  });

  // Rescore all as away/not-present
  const awaySignals: Signals = {
    present: false,
    headphones: false,
    eyesOnScreen: false,
    posture: "unknown",
    note: "Away — owner-confirmed absence from desk.",
  };
  const awayScore: ScoreResult = { score: 0, status: "away" };

  for (const snapshot of toRescore) {
    await correctSnapshot(snapshot.id, awaySignals, awayScore);
  }

  const hoursByDay = affectedHours(toRescore);
  const checkins = await rebuildHours(hoursByDay);

  // Count remaining non-away snapshots in the range
  const remaining = await snapshotsForDay(day);
  const remainingNonAway = remaining.filter((snapshot) => {
    if (!snapshot.present) return false; // already away

    const capturedAt = new Date(snapshot.capturedAt);
    const hour = localHour(capturedAt);
    const minute = capturedAt.getMinutes();

    const snapshotMinutes = hour * 60 + minute;
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    return snapshotMinutes >= startMinutes && snapshotMinutes < endMinutes;
  }).length;

  revalidateCaptures();

  return Response.json({
    target: {
      day,
      startHour,
      startMinute,
      endHour,
      endMinute,
    },
    rescored: {
      snapshots: toRescore.length,
      checkinsRebuilt: checkins.rebuilt,
      checkinsDeleted: checkins.deleted,
    },
    remaining: {
      nonAwaySnapshots: remainingNonAway,
    },
  });
}
