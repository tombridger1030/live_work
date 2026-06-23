import { localDayKey, localHour, previousHourWindow } from "@/lib/time";
import { saveHourlyCheckin, snapshotsSince } from "@/lib/store";
import type { HourlyCheckin, SnapshotRow } from "@/lib/types";

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function pct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

function verdictFor(snapshots: SnapshotRow[], avgScore: number, presentPct: number, headphonesPct: number): string {
  if (snapshots.length === 0) {
    return "No snapshots landed this hour.";
  }
  if (avgScore >= 80 && presentPct >= 80) {
    return `Locked in - ${presentPct}% present, ${headphonesPct}% headphones.`;
  }
  if (presentPct >= 50) {
    return `At desk - ${presentPct}% present, average focus ${avgScore}.`;
  }
  return `Away - ${presentPct}% present, average focus ${avgScore}.`;
}

export function buildHourlyCheckin(day: string, hour: number, snapshots: SnapshotRow[]): HourlyCheckin {
  const avgScore = average(snapshots.map((snapshot) => snapshot.score));
  const presentPct = pct(
    snapshots.filter((snapshot) => snapshot.present).length,
    snapshots.length
  );
  const headphonesPct = pct(
    snapshots.filter((snapshot) => snapshot.headphones).length,
    snapshots.length
  );

  return {
    day,
    hour,
    avgScore,
    presentPct,
    headphonesPct,
    verdict: verdictFor(snapshots, avgScore, presentPct, headphonesPct),
    critical: false
  };
}

/**
 * Rolls the in-progress local hour into one visible check-in.
 *
 * Preconditions: at least one capture path has authenticated the user or agent.
 * Postconditions: the local day-hour row reflects all snapshots captured from
 * the start of the current hour through `now`.
 */
export async function rollupCurrentHour(now = new Date()): Promise<HourlyCheckin> {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  const snapshots = (await snapshotsSince(start)).filter(
    (snapshot) => new Date(snapshot.capturedAt).getTime() <= now.getTime()
  );
  const checkin = buildHourlyCheckin(localDayKey(start), localHour(start), snapshots);
  return saveHourlyCheckin(checkin);
}

/**
 * Rolls the previous completed hour into one idempotent check-in.
 *
 * Preconditions: the caller has authenticated the cron request. Postconditions:
 * one row exists for the local day-hour, replacing any previous calculation for
 * that same hour.
 */
export async function rollupPreviousHour(now = new Date()): Promise<HourlyCheckin> {
  const { start, end } = previousHourWindow(now);
  const snapshots = (await snapshotsSince(start)).filter(
    (snapshot) => new Date(snapshot.capturedAt).getTime() < end.getTime()
  );
  const checkin = buildHourlyCheckin(localDayKey(start), localHour(start), snapshots);
  return saveHourlyCheckin(checkin);
}
