import { minutesSince } from "@/lib/time";
import type { SnapshotRow } from "@/lib/types";

export const captureCadenceLookbackMinutes = 120;

const activeIntervalMinutes = 5;
const awayBackoffMinutes = 15;
const deepAwayBackoffMinutes = 30;
const awayBackoffStartMinutes = 30;
const deepAwayBackoffStartMinutes = 60;

export type CaptureCadence = {
  due: boolean;
  intervalMinutes: typeof activeIntervalMinutes | typeof awayBackoffMinutes | typeof deepAwayBackoffMinutes;
  awayMinutes: number | null;
  nextDueAt: string | null;
};

function currentAwayStart(latest: SnapshotRow, recentSnapshots: SnapshotRow[]): string {
  const latestTime = new Date(latest.capturedAt).getTime();
  let start = latest.capturedAt;

  for (let index = recentSnapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = recentSnapshots[index];
    if (new Date(snapshot.capturedAt).getTime() > latestTime) {
      continue;
    }
    if (snapshot.status !== "away") {
      break;
    }
    start = snapshot.capturedAt;
  }

  return start;
}

function intervalFor(awayMinutes: number | null): CaptureCadence["intervalMinutes"] {
  if (awayMinutes === null || awayMinutes < awayBackoffStartMinutes) {
    return activeIntervalMinutes;
  }
  return awayMinutes >= deepAwayBackoffStartMinutes ? deepAwayBackoffMinutes : awayBackoffMinutes;
}

/**
 * Decides whether this launchd tick should open the camera and post a snapshot.
 *
 * Preconditions: `recentSnapshots` are ascending by `capturedAt` and cover at
 * least `captureCadenceLookbackMinutes`; `latest` is the newest stored snapshot
 * or null. Postconditions: present/locked-in work uses the normal 5-minute
 * cadence; a consecutive away streak backs off to 15 minutes after 30 minutes
 * away and 30 minutes after an hour away.
 */
export function captureCadenceFor(
  latest: SnapshotRow | null,
  recentSnapshots: SnapshotRow[],
  now = new Date()
): CaptureCadence {
  if (!latest) {
    return { due: true, intervalMinutes: activeIntervalMinutes, awayMinutes: null, nextDueAt: null };
  }

  const awayMinutes = latest.status === "away" ? minutesSince(currentAwayStart(latest, recentSnapshots), now) : null;
  const intervalMinutes = intervalFor(awayMinutes);
  const nextDueAtDate = new Date(new Date(latest.capturedAt).getTime() + intervalMinutes * 60_000);

  return {
    due: now.getTime() >= nextDueAtDate.getTime(),
    intervalMinutes,
    awayMinutes,
    nextDueAt: nextDueAtDate.toISOString()
  };
}

/**
 * Finds already-stored snapshots that the current capture cadence would have
 * skipped. Preconditions: `snapshots` are ascending by `capturedAt`.
 * Postconditions: non-away snapshots are always kept; away runs are thinned to
 * the same 5/15/30-minute cadence used by live capture.
 */
export function skippedSnapshotsForCaptureCadence(snapshots: SnapshotRow[]): SnapshotRow[] {
  const kept: SnapshotRow[] = [];
  const skipped: SnapshotRow[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.status !== "away" || captureCadenceFor(kept.at(-1) ?? null, kept, new Date(snapshot.capturedAt)).due) {
      kept.push(snapshot);
    } else {
      skipped.push(snapshot);
    }
  }

  return skipped;
}
