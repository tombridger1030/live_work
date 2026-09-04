import { captureIntervalMinutes, weekStartForDay } from "@/lib/time";
import type { LedgerEntry, WeeklyGoal } from "@/lib/types";

// The Ledger: a recent, week-grouped history (Monday → Sunday) with weekly
// targets. We only build the weeks that actually contain elapsed days, capped to
// the most recent quarter, never a year of empty cells.
export const LEDGER_WEEKS = 13; // ~a quarter of recent history, board fits one screen

// The bar that applies until the first weekly goal is saved. Every later week
// resolves its own effective-dated goal instead, so these are a starting point,
// never a live target.
export const WEEKLY_REACHOUT_TARGET = 250;
export const WEEKLY_HOURS_TARGET = 70;

export type WeeklyTargets = {
  reachouts: number;
  hours: number;
};

// One day's share of the goal set for the week that day belongs to. Days are
// scored against this and never against a module constant, so a goal saved for
// one week can only ever move that week's own days.
export type DailyTargets = {
  reachouts: number;
  hours: number;
};

const DEFAULT_WEEKLY_TARGETS: WeeklyTargets = {
  reachouts: WEEKLY_REACHOUT_TARGET,
  hours: WEEKLY_HOURS_TARGET,
};

/**
 * Splits a week's goal evenly across its seven days. Work runs Mon–Sun, so every
 * day carries the same share; there is no weekday/weekend weighting. Single
 * source of the week → day conversion: the day report, the board colors, and the
 * Telegram pace ladder all read the daily bar through here.
 */
export function dailyTargets(weekly: WeeklyTargets): DailyTargets {
  return { reachouts: weekly.reachouts / 7, hours: weekly.hours / 7 };
}

const monthDayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
});
const monthFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
});

export type DayState = "past" | "today" | "future";

export type LedgerDay = {
  day: string;
  index: number;
  label: string; // "Jun 15"
  dayOfMonth: number; // 15
  weekdayLabel: string; // "Mon"
  monthKey: string; // "2026-06", for month-boundary outlines
  monthLabel: string; // "Jun"
  inRange: boolean; // a real elapsed day inside the data window (vs an alignment pad)
  state: DayState;
  reachouts: number;
  hours: number;
  featureDone: boolean; // Legacy stored data only; never contributes to activity.
  replies: number;
  meetings: number;
  commits: number;
  merges: number;
  targets: DailyTargets; // this day's share of its own week's goal
  dailyValue: number;
  active: boolean;
};

export type LedgerWeek = {
  weekStart: string;
  weekEnd: string;
  label: string;
  reachouts: number;
  hours: number;
  replies: number;
  meetings: number;
  commits: number;
  merges: number;
  replyRate: number; // replies / reachouts, 0 when no reachouts
  bookingRate: number; // meetings / replies, 0 when no replies
  reachoutsPct: number;
  hoursPct: number;
  weeklyValue: number;
  reachoutsTarget: number;
  hoursTarget: number;
  days: LedgerDay[];
};

export type LedgerData = {
  startDay: string;
  endDay: string;
  today: string;
  todayIndex: number | null;
  days: LedgerDay[];
  weeks: LedgerWeek[];
  weekdayAverages: { weekday: string; averageValue: number }[];
  dailyChart: {
    day: string;
    label: string;
    dailyValue: number;
    movingAverage7: number | null;
  }[];
  weeklyChart: { weekStart: string; label: string; weeklyValue: number }[];
  totals: {
    daysElapsed: number;
    activeDays: number;
    activeDayStreak: number;
    reachoutsSum: number;
    hoursSum: number;
  };
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

/**
 * Scores activity 0-100: reachouts carry 4/7 and hours 3/7 of the score.
 * Each contribution caps at its target. This does not measure code velocity.
 * `targets` is required: handing in the week's resolved goal is the only way to
 * score a day, which is what keeps a module constant from standing in for a goal
 * the owner actually set. A component target of zero or less counts as already
 * met, so a day is never punished for a bar that cannot be cleared.
 */
export function dailyValue(
  reachouts: number,
  hours: number,
  targets: DailyTargets,
): number {
  const reachoutsPct =
    targets.reachouts > 0 ? Math.min(1, reachouts / targets.reachouts) : 1;
  const hoursPct = targets.hours > 0 ? Math.min(1, hours / targets.hours) : 1;
  return Math.round(
    100 * ((reachoutsPct * 4 + hoursPct * 3) / 7),
  );
}
/**
 * Resolves the latest effective-dated goal at or before a Monday week start.
 * The default applies until the first saved goal; input order is irrelevant.
 */
export function resolveWeeklyGoal(
  weekStart: string,
  goals: WeeklyGoal[],
): WeeklyTargets {
  let resolved = DEFAULT_WEEKLY_TARGETS;
  let latestWeekStart: string | null = null;
  for (const goal of goals) {
    if (
      goal.weekStart <= weekStart &&
      (latestWeekStart === null || goal.weekStart > latestWeekStart)
    ) {
      resolved = {
        reachouts: goal.reachouts,
        hours: goal.hours,
      };
      latestWeekStart = goal.weekStart;
    }
  }
  return resolved;
}

/** Returns capped weekly activity progress using the same weights as a day. */
export function weeklyProgress(
  reachouts: number,
  hours: number,
  targets: WeeklyTargets = DEFAULT_WEEKLY_TARGETS,
) {
  const reachoutsPct = targets.reachouts > 0 ? Math.min(1, reachouts / targets.reachouts) : 1;
  const hoursPct = targets.hours > 0 ? Math.min(1, hours / targets.hours) : 1;
  return {
    reachoutsPct,
    hoursPct,
    weeklyValue: dailyValue(reachouts, hours, targets),
  };
}

export function activeDayStreak(
  days: { state: DayState; active: boolean }[],
): number {
  const elapsed = days.filter((day) => day.state !== "future");
  let index = elapsed.length - 1;
  if (
    index >= 0 &&
    elapsed[index].state === "today" &&
    !elapsed[index].active
  ) {
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
  rangeStart: string,
  weeklyGoals: WeeklyGoal[] = [],
): LedgerData {
  const startDay = days[0];
  const endDay = days[days.length - 1];

  // One goal lookup per week, reused by that week's day scores and by its own
  // totals, so a day can never be scored against a different bar than the week
  // it sits inside. Keyed by real Monday, which is what resolveWeeklyGoal
  // expects and what makes a later week's goal unable to reach backwards.
  const weeklyByWeekStart = new Map<string, WeeklyTargets>();
  const weeklyTargetsFor = (day: string): WeeklyTargets => {
    const weekStart = weekStartForDay(day);
    const cached = weeklyByWeekStart.get(weekStart);
    if (cached) {
      return cached;
    }
    const resolved = resolveWeeklyGoal(weekStart, weeklyGoals);
    weeklyByWeekStart.set(weekStart, resolved);
    return resolved;
  };

  const ledgerDays: LedgerDay[] = days.map((day, position) => {
    const at = new Date(`${day}T12:00:00Z`);
    const state: DayState =
      day < today ? "past" : day === today ? "today" : "future";
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
    const hours = inRange ? (hoursByDay.get(day) ?? 0) : 0;
    const targets = dailyTargets(weeklyTargetsFor(day));
    const dv = inRange ? dailyValue(reachouts, hours, targets) : 0;
    const active = inRange && (reachouts > 0 || hours > 0);
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
      targets,
      dailyValue: dv,
      active,
    };
  });

  // Build weeks Monday → Sunday: a new week begins on each Monday.
  const weeks: LedgerWeek[] = [];
  let currentWeek: LedgerDay[] = [];
  for (const day of ledgerDays) {
    const dow = new Date(`${day.day}T12:00:00Z`).getUTCDay();
    if (dow === 1 && currentWeek.length > 0) {
      weeks.push(buildWeek(currentWeek, weeklyTargetsFor(currentWeek[0].day)));
      currentWeek = [];
    }
    currentWeek.push(day);
  }
  if (currentWeek.length > 0) {
    weeks.push(buildWeek(currentWeek, weeklyTargetsFor(currentWeek[0].day)));
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
    averageValue:
      weekdayCounts[i] > 0 ? Math.round(weekdaySums[i] / weekdayCounts[i]) : 0,
  }));

  // Daily chart: every in-range day + 7-day moving average.
  const dailyChart = elapsedDays.map((d, i) => {
    let movingAverage7: number | null = null;
    if (i >= 6) {
      const window = elapsedDays.slice(i - 6, i + 1);
      movingAverage7 = Math.round(
        window.reduce((sum, w) => sum + w.dailyValue, 0) / 7,
      );
    }
    return {
      day: d.day,
      label: d.label,
      dailyValue: d.dailyValue,
      movingAverage7,
    };
  });

  const weeklyChart = weeks
    .filter((w) => w.days.some((d) => d.inRange))
    .map((w) => ({
      weekStart: w.weekStart,
      label: w.label,
      weeklyValue: w.weeklyValue,
    }));

  const todayDay = ledgerDays.find((d) => d.day === today) ?? null;
  const totals = {
    daysElapsed: elapsedDays.length,
    activeDays: elapsedDays.filter((d) => d.active).length,
    activeDayStreak: activeDayStreak(ledgerDays.filter((d) => d.inRange)),
    reachoutsSum: elapsedDays.reduce((sum, d) => sum + d.reachouts, 0),
    hoursSum:
      Math.round(elapsedDays.reduce((sum, d) => sum + d.hours, 0) * 10) / 10,
  };

  return {
    startDay,
    endDay,
    today,
    todayIndex: todayDay?.index ?? null,
    days: ledgerDays,
    weeks,
    weekdayAverages,
    dailyChart,
    weeklyChart,
    totals,
  };
}

function buildWeek(weekDays: LedgerDay[], targets: WeeklyTargets): LedgerWeek {
  const elapsedDays = weekDays.filter((d) => d.inRange);
  const reachouts = elapsedDays.reduce((sum, d) => sum + d.reachouts, 0);
  const hours =
    Math.round(elapsedDays.reduce((sum, d) => sum + d.hours, 0) * 10) / 10;
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
  const progress = weeklyProgress(reachouts, hours, targets);
  return {
    weekStart,
    weekEnd,
    label,
    reachouts,
    hours,
    replies,
    meetings,
    commits,
    merges,
    replyRate,
    bookingRate,
    reachoutsPct: progress.reachoutsPct,
    hoursPct: progress.hoursPct,
    weeklyValue: progress.weeklyValue,
    reachoutsTarget: targets.reachouts,
    hoursTarget: targets.hours,
    days: weekDays,
  };
}
