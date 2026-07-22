export const freshSnapshotMinutes = 40;

// Minutes between captures = the plist's every-5-minutes calendar schedule.
// Each scored snapshot stands for this much elapsed time, so "hours present" =
// present snapshots × this ÷ 60. MUST match agent/com.tombridger.work-live.plist.
export const captureIntervalMinutes = 5;

export function appTimeZone(): string {
  return process.env.WORK_LIVE_TIME_ZONE || "America/Vancouver";
}

export function minutesSince(isoDate: string, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(isoDate).getTime()) / 60000));
}

export function isSnapshotFresh(isoDate: string, now = new Date()): boolean {
  return minutesSince(isoDate, now) <= freshSnapshotMinutes;
}

export function localDayKey(date: Date, timeZone = appTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Unable to format local day key");
  }
  return `${year}-${month}-${day}`;
}

/** Returns true only for a real UTC calendar day key. */
export function isValidDayKey(dayKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return false;
  }
  const at = new Date(`${dayKey}T12:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === dayKey;
}

/** Returns the UTC Monday key for a normalized YYYY-MM-DD day key. */
export function weekStartForDay(dayKey: string): string {
  const at = new Date(`${dayKey}T12:00:00Z`);
  const daysSinceMonday = (at.getUTCDay() + 6) % 7;
  at.setUTCDate(at.getUTCDate() - daysSinceMonday);
  return at.toISOString().slice(0, 10);
}

/** Returns true only for a real calendar Monday key. */
export function isMondayWeekStart(dayKey: string): boolean {
  return isValidDayKey(dayKey) && weekStartForDay(dayKey) === dayKey;
}

export function localHour(date: Date, timeZone = appTimeZone()): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false
  }).format(date);
  return Number(hour === "24" ? "0" : hour);
}

function localMinute(date: Date, timeZone = appTimeZone()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(date));
}

export function previousHourWindow(now = new Date()): { start: Date; end: Date } {
  const end = new Date(now);
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start, end };
}

// Overnight quiet window: no capture happens and these hours are hidden on the
// timeline. Half-open [start, end) in local time, so 1am–7:59am is quiet and
// capture resumes at 8am (the working day runs 8am→12am, dark in between). Single
// source for both the agent and the page.
export const quietHourStart = 1;
export const quietHourEnd = 8;

export function isQuietHour(hour: number): boolean {
  return hour >= quietHourStart && hour < quietHourEnd;
}

// Minutes elapsed since the most recent morning capture start (quietHourEnd,
// 8am local). Hours before 8am (the past-midnight tail plus the quiet window)
// belong to the PREVIOUS working day, so their morning is yesterday's 8am and
// overnight away streaks stay intact. This is the daily AFK reset boundary:
// capture cadence never carries an away streak across it, so a fresh morning
// always starts at the 5-minute cadence no matter how long the machine sat
// idle or off the days before.
export function minutesSinceMorningStart(now = new Date(), timeZone = appTimeZone()): number {
  const hour = localHour(now, timeZone);
  const dayHour = hour >= quietHourEnd ? hour : hour + 24;
  return (dayHour - quietHourEnd) * 60 + localMinute(now, timeZone);
}

export function isQuietNow(now = new Date(), timeZone = appTimeZone()): boolean {
  return isQuietHour(localHour(now, timeZone));
}

// Productive scoring window: only 8am–11pm contributes to a day's average score
// and stats. Hours outside it (incl. the overnight quiet window and late night)
// are still captured/shown but never counted toward the day's score. Half-open
// [start, end) in local time, so 8am..10:59pm count and 11pm closes the day.
export const scoringStartHour = 8;
export const scoringEndHour = 23;

export function isScoringHour(hour: number): boolean {
  return hour >= scoringStartHour && hour < scoringEndHour;
}
