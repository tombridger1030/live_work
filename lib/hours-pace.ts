import {
  captureIntervalMinutes,
  isValidDayKey,
  localDayKey,
  scoringEndHour,
  scoringStartHour,
} from "@/lib/time";

export const HOURS_PACE_HISTORY_DAYS = 28;
export const HOURS_PACE_MIN_DAYS = 3;

/** Complete prior-day desk captures, in local minutes since midnight. */
export type HoursReferenceDay = {
  day: string;
  minutes: number[];
  target: number;
};

/** Server-evaluated live input. No part of today's actual work trains it. */
export type HoursPaceContext = {
  day: string;
  asOf: string;
  timeZone: string;
  fraction: number | null;
  elapsedHours: number;
  closed: boolean;
  referenceDays: string[];
  basis: "successful" | "stronger" | "learning";
};

export type HoursPace = {
  expectedHours: number | null;
  progress: number;
  deltaHours: number | null;
  state: "behind" | "on pace" | "ahead" | "done" | "not due yet" | "learning";
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Local wall-clock minutes, independent of the browser's timezone and DST offset. */
export function localClockMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const part = (name: string) => Number(parts.find((value) => value.type === name)?.value);
  return part("hour") * 60 + part("minute") + part("second") / 60;
}

/**
 * Learns today's expected cumulative share from prior observed weekdays within
 * 28 calendar days. Inputs contain deduplicated, complete scoring-window desk
 * captures and that day's historical hours target; times are local minutes.
 * Requires three stronger days (desk totals at least the observed median).
 * Prefers three goal-reaching stronger days; otherwise identifies the stronger
 * baseline as provisional. Empty/tiny days cannot outweigh productive days.
 * Each capture credits the preceding capture interval, interpolated at `now`.
 * No current/future day or actual-hours input can move today's expected curve.
 */
export function learnHoursPace(
  history: HoursReferenceDay[],
  now: Date,
  timeZone: string,
): HoursPaceContext {
  if (!Number.isFinite(now.getTime())) throw new Error("Hours pace requires a valid clock");
  const day = localDayKey(now, timeZone);
  const cutoff = new Date(`${day}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - HOURS_PACE_HISTORY_DAYS);
  const oldest = cutoff.toISOString().slice(0, 10);
  const minute = localClockMinutes(now, timeZone);
  const candidates = history.filter((entry) => {
    const weekday = new Date(`${entry.day}T12:00:00Z`).getUTCDay();
    return isValidDayKey(entry.day) && entry.day >= oldest && entry.day < day &&
      weekday >= 1 && weekday <= 5 && entry.minutes.length > 0 &&
      Number.isFinite(entry.target) && entry.target >= 0 &&
      entry.minutes.every((value) => Number.isFinite(value) &&
        value >= scoringStartHour * 60 && value < scoringEndHour * 60);
  });
  const floor = candidates.length ? median(candidates.map((entry) => entry.minutes.length)) : Infinity;
  const stronger = candidates.filter((entry) => entry.minutes.length >= floor);
  const successful = stronger.filter((entry) => entry.target > 0 &&
    Math.round(entry.minutes.length * captureIntervalMinutes / 60 * 10) / 10 >= entry.target);
  const references = successful.length >= HOURS_PACE_MIN_DAYS ? successful : stronger;
  const ready = references.length >= HOURS_PACE_MIN_DAYS;
  const fraction = ready ? median(references.map((entry) =>
    entry.minutes.reduce((sum, at) => sum + Math.max(0, Math.min(1,
      (minute - at + captureIntervalMinutes) / captureIntervalMinutes)), 0) / entry.minutes.length,
  )) : null;
  return {
    day, asOf: now.toISOString(), timeZone,
    fraction: minute >= scoringEndHour * 60 ? 1 : fraction,
    elapsedHours: Math.max(0, (minute - scoringStartHour * 60) / 60),
    closed: minute >= scoringEndHour * 60,
    referenceDays: ready ? references.map((entry) => entry.day).sort() : [],
    basis: ready ? successful.length >= HOURS_PACE_MIN_DAYS ? "successful" : "stronger" : "learning",
  };
}

/**
 * Applies a learned clock share to today's full catch-up goal, in hours.
 * Preconditions: credited actual and full target are finite, nonnegative hours.
 * Expected work cannot exceed elapsed scoring time; at day close the full goal
 * applies, even when ambitious. Away work may count as actual, never training.
 * Sparse history keeps full-goal scoring and reports no learned expectation.
 * Before work is due, zero work earns no hours points. Status has one capture
 * interval of tolerance for sampling/rounded desk totals; score is continuous.
 */
export function hoursPaceForGoal(
  context: HoursPaceContext,
  actual: number,
  target: number,
): HoursPace {
  if (![actual, target].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Hours pace requires finite nonnegative hours");
  }
  const expectedHours = context.closed ? target : context.fraction === null ? null :
    Math.min(target, context.elapsedHours, target * context.fraction);
  const progress = target === 0 ? 1 : expectedHours === null ? Math.min(1, actual / target) :
    expectedHours === 0 ? actual > 0 ? 1 : 0 : Math.min(1, actual / expectedHours);
  const deltaHours = expectedHours === null ? null : actual - expectedHours;
  const tolerance = captureIntervalMinutes / 60;
  const state: HoursPace["state"] = actual >= target ? "done" :
    expectedHours === null ? "learning" : expectedHours === 0 ? "not due yet" :
    deltaHours! < -tolerance ? "behind" : deltaHours! > tolerance ? "ahead" : "on pace";
  return { expectedHours, progress, deltaHours, state };
}
