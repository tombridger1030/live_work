import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { skippedSnapshotsForCaptureCadence } from "@/lib/capture-cadence";
import { getOptionalEnv } from "@/lib/env";
import { buildHourlyCheckin } from "@/lib/rollup";
import {
  deleteHourlyCheckin,
  deleteSnapshotsByIds,
  saveHourlyCheckin,
  snapshotsForDay,
  snapshotsSince
} from "@/lib/store";
import { localDayKey, localHour } from "@/lib/time";
import type { SnapshotRow } from "@/lib/types";

export const runtime = "nodejs";

const allStoredSnapshotsStart = new Date(0);

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
 * Owner-authenticated maintenance: removes historical away snapshots that the
 * current AFK backoff cadence would have skipped, then rebuilds affected hours.
 * Idempotent — re-running after cleanup deletes nothing.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  const snapshots = await snapshotsSince(allStoredSnapshotsStart);
  const skipped = skippedSnapshotsForCaptureCadence(snapshots);
  const hoursByDay = affectedHours(skipped);
  const deletedSnapshots = await deleteSnapshotsByIds(skipped.map((snapshot) => snapshot.id));
  const checkins = await rebuildHours(hoursByDay);
  const remainingSnapshots = skippedSnapshotsForCaptureCadence(await snapshotsSince(allStoredSnapshotsStart)).length;

  revalidateCaptures();
  return Response.json({
    deleted: {
      snapshots: deletedSnapshots,
      checkinsRebuilt: checkins.rebuilt,
      checkinsDeleted: checkins.deleted
    },
    remaining: {
      snapshots: remainingSnapshots
    }
  });
}
