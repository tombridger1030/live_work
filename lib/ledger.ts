import { captureIntervalMinutes } from "@/lib/time";
import type { LedgerEntry, NudgeMessage } from "@/lib/types";

// The Ledger: a recent, week-grouped history (Monday → Sunday) with weekly
// targets. We only build the weeks that actually contain elapsed days, capped to
// the most recent quarter — never a year of empty cells.
export const LEDGER_WEEKS = 13; // ~a quarter of recent history, board fits one screen
export const WEEKLY_REACHOUT_TARGET = 250;
export const WEEKLY_HOURS_TARGET = 70;
export const WEEKLY_FEATURE_TARGET = 7;
export const DAILY_REACHOUT_REFERENCE = WEEKLY_REACHOUT_TARGET / 7;
export const DAILY_HOURS_REFERENCE = WEEKLY_HOURS_TARGET / 7;

const monthDayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });

export type DayState = "past" | "today" | "future";

export type LedgerDay = {
  day: string;
  index: number;
  label: string; // "Jun 15"
  dayOfMonth: number; // 15
  weekdayLabel: string; // "Mon"
  monthKey: string; // "2026-06" — for month-boundary outlines
  monthLabel: string; // "Jun"
  inRange: boolean; // a real elapsed day inside the data window (vs an alignment pad)
  state: DayState;
  reachouts: number;
  hours: number;
  featureDone: boolean;
  replies: number;
  meetings: number;
  commits: number;
  merges: number;
  dailyValue: number;
  active: boolean;
};

export type LedgerWeek = {
  weekStart: string;
  weekEnd: string;
  label: string;
  reachouts: number;
  hours: number;
  features: number;
  replies: number;
  meetings: number;
  commits: number;
  merges: number;
  replyRate: number; // replies / reachouts, 0 when no reachouts
  bookingRate: number; // meetings / replies, 0 when no replies
  reachoutsPct: number;
  hoursPct: number;
  featuresPct: number;
  weeklyValue: number;
  days: LedgerDay[];
};

export type LedgerData = {
  startDay: string;
  endDay: string;
  today: string;
  todayIndex: number | null;
  targets: {
    weeklyReachouts: 250;
    weeklyHours: 70;
    weeklyFeatures: 7;
    dailyReachoutReference: number;
    dailyHoursReference: number;
  };
  days: LedgerDay[];
  weeks: LedgerWeek[];
  weekdayAverages: { weekday: string; averageValue: number }[];
  dailyChart: { day: string; label: string; dailyValue: number; movingAverage7: number | null }[];
  weeklyChart: { weekStart: string; label: string; weeklyValue: number }[];
  totals: {
    daysElapsed: number;
    activeDays: number;
    activeDayStreak: number;
    reachoutsSum: number;
    hoursSum: number;
    featuresSum: number;
  };
  messages: NudgeMessage[];
};

export function dayRange(startDay: string, endDay: string): string[] {
  const out: string[] = [];
  const day = new Date(`${startDay}T12:00:00Z`);
  const end = new Date(`${endDay}T12:00:00Z`);
  while (day <= end) {
    out.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

export function hoursFromPresent(present: number): number {
  return Math.round(((present * captureIntervalMinutes) / 60) * 10) / 10;
}

export function dailyValue(reachouts: number, hours: number, featureDone: boolean): number {
  return Math.round(100 * (
    Math.min(1, reachouts / DAILY_REACHOUT_REFERENCE) * 0.4 +
    Math.min(1, hours / DAILY_HOURS_REFERENCE) * 0.3 +
    (featureDone ? 1 : 0) * 0.3
  ));
}
export function weeklyValue(reachouts: number, hours: number, features: number): number {
  return weeklyProgress(reachouts, hours, features).weeklyValue;
}
export function weeklyProgress(reachouts: number, hours: number, features: number) {
  const reachoutsPct = Math.min(1, reachouts / WEEKLY_REACHOUT_TARGET);
  const hoursPct = Math.min(1, hours / WEEKLY_HOURS_TARGET);
  const featuresPct = Math.min(1, features / WEEKLY_FEATURE_TARGET);
  return {
    reachoutsPct,
    hoursPct,
    featuresPct,
    weeklyValue: Math.round(100 * (reachoutsPct * 0.4 + hoursPct * 0.3 + featuresPct * 0.3))
  };
}

export function activeDayStreak(days: { state: DayState; active: boolean }[]): number {
  const elapsed = days.filter((day) => day.state !== "future");
  let index = elapsed.length - 1;
  if (index >= 0 && elapsed[index].state === "today" && !elapsed[index].active) {
    index -= 1;
  }
  let streak = 0;
  for (; index >= 0; index -= 1) {
    if (!elapsed[index].active) {
      break;
    }
    streak += 1;
  }
  return streak;
}

// Weekday average row + board columns both run Monday → Sunday (the user works
// Mon–Sun, not Sun–Sat).
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Monday-first weekday index (0 = Mon … 6 = Sun) from a JS UTC day (0 = Sun).
function mondayIndex(utcDay: number): number {
  return (utcDay + 6) % 7;
}

export function assembleLedger(
  days: string[],
  entries: Map<string, LedgerEntry>,
  hoursByDay: Map<string, number>,
  today: string,
  rangeStart: string
): Omit<LedgerData, "messages"> {
  // Messages are added by getLedgerData (it owns the nudge log); assembleLedger
  // has no message data, so it returns everything but that field.
  const startDay = days[0];
  const endDay = days[days.length - 1];

  const ledgerDays: LedgerDay[] = days.map((day, position) => {
    const at = new Date(`${day}T12:00:00Z`);
    const state: DayState = day < today ? "past" : day === today ? "today" : "future";
    // A real elapsed day inside the data window. Days before the first data point
    // or after today are only alignment padding for the Monday grid.
    const inRange = day >= rangeStart && day <= today;
    const entry = inRange ? entries.get(day) : undefined;
    const reachouts = entry?.reachouts ?? 0;
    const featureDone = entry?.featureDone ?? false;
    const replies = entry?.replies ?? 0;
    const meetings = entry?.meetings ?? 0;
    const commits = entry?.commits ?? 0;
    const merges = entry?.merges ?? 0;
    const hours = inRange ? hoursByDay.get(day) ?? 0 : 0;
    const dv = inRange ? dailyValue(reachouts, hours, featureDone) : 0;
    const active = inRange && (reachouts > 0 || hours > 0 || featureDone);
    return {
      day,
      index: position + 1,
      label: monthDayFormat.format(at),
      dayOfMonth: at.getUTCDate(),
      weekdayLabel: weekdayFormat.format(at),
      monthKey: day.slice(0, 7),
      monthLabel: monthFormat.format(at),
      inRange,
      state,
      reachouts,
      hours,
      featureDone,
      replies,
      meetings,
      commits,
      merges,
      dailyValue: dv,
      active
    };
  });

  // Build weeks Monday → Sunday: a new week begins on each Monday.
  const weeks: LedgerWeek[] = [];
  let currentWeek: LedgerDay[] = [];
  for (const day of ledgerDays) {
    const dow = new Date(`${day.day}T12:00:00Z`).getUTCDay();
    if (dow === 1 && currentWeek.length > 0) {
      weeks.push(buildWeek(currentWeek));
      currentWeek = [];
    }
    currentWeek.push(day);
  }
  if (currentWeek.length > 0) {
    weeks.push(buildWeek(currentWeek));
  }

  const elapsedDays = ledgerDays.filter((d) => d.inRange);

  // Weekday averages from in-range days only, Monday-first.
  const weekdaySums = new Array(7).fill(0) as number[];
  const weekdayCounts = new Array(7).fill(0) as number[];
  for (const day of elapsedDays) {
    const idx = mondayIndex(new Date(`${day.day}T12:00:00Z`).getUTCDay());
    weekdaySums[idx] += day.dailyValue;
    weekdayCounts[idx] += 1;
  }
  const weekdayAverages = WEEKDAY_LABELS.map((weekday, i) => ({
    weekday,
    averageValue: weekdayCounts[i] > 0 ? Math.round(weekdaySums[i] / weekdayCounts[i]) : 0
  }));

  // Daily chart: every in-range day + 7-day moving average.
  const dailyChart = elapsedDays.map((d, i) => {
    let movingAverage7: number | null = null;
    if (i >= 6) {
      const window = elapsedDays.slice(i - 6, i + 1);
      movingAverage7 = Math.round(window.reduce((sum, w) => sum + w.dailyValue, 0) / 7);
    }
    return { day: d.day, label: d.label, dailyValue: d.dailyValue, movingAverage7 };
  });

  const weeklyChart = weeks
    .filter((w) => w.days.some((d) => d.inRange))
    .map((w) => ({ weekStart: w.weekStart, label: w.label, weeklyValue: w.weeklyValue }));

  const todayDay = ledgerDays.find((d) => d.day === today) ?? null;
  const totals = {
    daysElapsed: elapsedDays.length,
    activeDays: elapsedDays.filter((d) => d.active).length,
    activeDayStreak: activeDayStreak(ledgerDays.filter((d) => d.inRange)),
    reachoutsSum: elapsedDays.reduce((sum, d) => sum + d.reachouts, 0),
    hoursSum: Math.round(elapsedDays.reduce((sum, d) => sum + d.hours, 0) * 10) / 10,
    featuresSum: elapsedDays.filter((d) => d.featureDone).length
  };

  return {
    startDay,
    endDay,
    today,
    todayIndex: todayDay?.index ?? null,
    targets: {
      weeklyReachouts: 250,
      weeklyHours: 70,
      weeklyFeatures: 7,
      dailyReachoutReference: DAILY_REACHOUT_REFERENCE,
      dailyHoursReference: DAILY_HOURS_REFERENCE
    },
    days: ledgerDays,
    weeks,
    weekdayAverages,
    dailyChart,
    weeklyChart,
    totals
  };
}

function buildWeek(weekDays: LedgerDay[]): LedgerWeek {
  const elapsedDays = weekDays.filter((d) => d.inRange);
  const reachouts = elapsedDays.reduce((sum, d) => sum + d.reachouts, 0);
  const hours = Math.round(elapsedDays.reduce((sum, d) => sum + d.hours, 0) * 10) / 10;
  const features = elapsedDays.filter((d) => d.featureDone).length;
  const replies = elapsedDays.reduce((sum, d) => sum + d.replies, 0);
  const meetings = elapsedDays.reduce((sum, d) => sum + d.meetings, 0);
  const commits = elapsedDays.reduce((sum, d) => sum + d.commits, 0);
  const merges = elapsedDays.reduce((sum, d) => sum + d.merges, 0);
  // Sell funnel rates: replies per reachout, meetings per reply. Guard the
  // denominators so a week with no reachouts/replies reads 0, not NaN.
  const replyRate = reachouts > 0 ? replies / reachouts : 0;
  const bookingRate = replies > 0 ? meetings / replies : 0;
  const weekStart = weekDays[0].day;
  const weekEnd = weekDays[weekDays.length - 1].day;
  const startLabel = weekDays[0].label;
  const endLabel = weekDays[weekDays.length - 1].label;
  const label = `${startLabel}–${endLabel}`;
  const progress = weeklyProgress(reachouts, hours, features);
  return {
    weekStart,
    weekEnd,
    label,
    reachouts,
    hours,
    features,
    replies,
    meetings,
    commits,
    merges,
    replyRate,
    bookingRate,
    reachoutsPct: progress.reachoutsPct,
    hoursPct: progress.hoursPct,
    featuresPct: progress.featuresPct,
    weeklyValue: progress.weeklyValue,
    days: weekDays
  };
}
