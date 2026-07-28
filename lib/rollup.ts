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

function verdictFor(snapshots: SnapshotRow[], avgScore: number, presentPct: number, headphonesPct: number, unknown: number): string {
  if (snapshots.length === 0) {
    return "No snapshots landed this hour.";
  }
  if (unknown === snapshots.length) {
    return `Not measured - ${presentPct}% present, but no frame was examined (focus at least ${avgScore}).`;
  }
  // "at least" is the honest framing: unexamined frames sit at their presence floor,
  // so the printed focus is a lower bound the owner can raise by correcting them.
  const caveat = unknown > 0 ? ` (${unknown} frame${unknown === 1 ? "" : "s"} not examined, so focus is at least this)` : "";
  if (avgScore >= 80 && presentPct >= 80) {
    return `Locked in - ${presentPct}% present, ${headphonesPct}% headphones.${caveat}`;
  }
  if (presentPct >= 50) {
    return `At desk - ${presentPct}% present, average focus ${avgScore}.${caveat}`;
  }
  return `Away - ${presentPct}% present, average focus ${avgScore}.${caveat}`;
}

/**
 * One hour's visible aggregate.
 *
 * Two different treatments, because the two numbers fail differently when nothing
 * examined a frame:
 *
 * `headphonesPct` EXCLUDES unexamined frames. It is a percentage over frames a
 * model actually judged, because their `headphones: false` is a placeholder and
 * counting it as an explicit "no" understated the record by 12 points across 415
 * frames.
 *
 * `avgScore` KEEPS them, at their stored presence-floor score. Dropping them
 * instead was tried and was worse: in an hour of 11 unexamined present frames plus
 * 1 genuinely-away frame, the average collapsed to the away frame alone and printed
 * 0 for an hour that was 92% present — below the hour's true lower bound, in 59
 * hours of real history. An unexamined present frame is known to be worth AT LEAST
 * its presence score, so including it makes `avgScore` a floor: never an
 * over-claim, never below what was actually observed.
 *
 * `presentPct` is untouched — local detection genuinely verified the desk.
 *
 * Postconditions: `unknownFrames` is how many frames nothing judged, so the UI can
 * mark the hour incomplete and invite a correction. Callers must treat `avgScore`
 * on such an hour as a lower bound rather than a measurement.
 */
export function buildHourlyCheckin(day: string, hour: number, snapshots: SnapshotRow[]): HourlyCheckin {
  const examined = snapshots.filter((snapshot) => snapshot.visionRead !== "unknown");
  const unknownFrames = snapshots.length - examined.length;

  const avgScore = average(snapshots.map((snapshot) => snapshot.score));
  const presentPct = pct(
    snapshots.filter((snapshot) => snapshot.present).length,
    snapshots.length
  );
  const headphonesPct = pct(
    examined.filter((snapshot) => snapshot.headphones).length,
    examined.length
  );

  return {
    day,
    hour,
    avgScore,
    presentPct,
    headphonesPct,
    unknownFrames,
    verdict: verdictFor(snapshots, avgScore, presentPct, headphonesPct, unknownFrames),
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
