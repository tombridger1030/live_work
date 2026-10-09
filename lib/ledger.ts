import {
  readManualCounts,
  newTouches,
  type ManualCounts,
} from "@/lib/ledger-fields";
import {
  buildOutreachFunnel,
  followUpsDue,
  splitStartDay,
  type FollowUpsDue,
  type OutreachFunnel,
} from "@/lib/outreach-funnel";
import {
  dailyOutreachBar,
  outreachProgress,
  outreachTally,
  type OutreachGoal,
  type OutreachTally,
} from "@/lib/outreach-pace";
import { captureIntervalMinutes, weekStartForDay } from "@/lib/time";
import type { LedgerEntry, WeeklyGoal } from "@/lib/types";
import { outreachGoalOf, storedWeeklyGoal } from "@/lib/weekly-goal";

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
  outreach: OutreachGoal;
  hours: number;
};

/**
 * One day's bars. `outreach` is that weekday's catch-up share of its own week's
 * goal (see lib/outreach-pace.ts), and null on Saturday and Sunday: no outreach
 * is expected, so the day is scored on hours alone. `hours` is the week's hours
 * goal spread evenly over all seven days.
 */
export type DailyTargets = {
  outreach: OutreachGoal | null;
  hours: number;
};

/** Hand-entered fields a day can be patched with: every count, plus the legacy flag. */
export type LedgerDayPatch = Partial<ManualCounts> & { featureDone?: boolean };

const DEFAULT_WEEKLY_TARGETS: WeeklyTargets = {
  outreach: { kind: "touches", touches: WEEKLY_REACHOUT_TARGET },
  hours: WEEKLY_HOURS_TARGET,
};

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

export type LedgerDay = ManualCounts & {
  day: string;
  index: number;
  label: string; // "Jun 15"
  dayOfMonth: number; // 15
  weekdayLabel: string; // "Mon"
  monthKey: string; // "2026-06", for month-boundary outlines
  monthLabel: string; // "Jun"
  inRange: boolean; // a real elapsed day inside the data window (vs an alignment pad)
  state: DayState;
  hours: number;
  featureDone: boolean; // Legacy stored data only; never contributes to activity.
  commits: number;
  merges: number;
  targets: DailyTargets; // this day's share of its own week's goal
  due: FollowUpsDue | null; // follow-ups this day owes; null on weekends and before the split
  dailyValue: number;
  active: boolean;
};

export type LedgerWeek = {
  weekStart: string;
  weekEnd: string;
  label: string;
  counts: ManualCounts; // every manual count summed over the week's elapsed days
  touches: number; // new-prospect touches: unsplit touches + emails + connection requests
  hours: number;
  commits: number;
  merges: number;
  goal: WeeklyTargets; // the goal this week is measured against
  outreachPct: number;
  hoursPct: number;
  weeklyValue: number;
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
  funnel: OutreachFunnel;
  totals: {
    daysElapsed: number;
    activeDays: number;
    activeDayStreak: number;
    touchesSum: number;
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

function hoursProgress(hours: number, target: number): number {
  return target > 0 ? Math.min(1, hours / target) : 1;
}

/**
 * Scores a day's activity 0-100 against that day's own bars.
 *
 * Weekday: outreach carries 4/7 and hours 3/7, each capped at its bar
 * (`outreachProgress` caps each channel separately). Weekend (`outreach` is
 * null): hours alone carry the score, because a weekend outreach bar of zero
 * would otherwise hand out 4/7 for free. A bar of zero or less on a weekday
 * means the owner is ahead of pace, so it counts as met. Outputs (accepts,
 * replies, meetings) never touch the score; this does not measure code velocity.
 */
export function dailyValue(
  tally: OutreachTally,
  hours: number,
  targets: DailyTargets,
): number {
  const hoursPct = hoursProgress(hours, targets.hours);
  if (targets.outreach === null) {
    return Math.round(100 * hoursPct);
  }
  return Math.round(
    100 * ((outreachProgress(tally, targets.outreach) * 4 + hoursPct * 3) / 7),
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
      resolved = { outreach: outreachGoalOf(goal), hours: goal.hours };
      latestWeekStart = goal.weekStart;
    }
  }
  return resolved;
}

/** Capped weekly progress, weighted like a weekday (outreach 4/7, hours 3/7). */
export function weeklyProgress(
  tally: OutreachTally,
  hours: number,
  targets: WeeklyTargets = DEFAULT_WEEKLY_TARGETS,
) {
  const outreachPct = outreachProgress(tally, targets.outreach);
  const hoursPct = hoursProgress(hours, targets.hours);
  return {
    outreachPct,
    hoursPct,
    weeklyValue: Math.round(100 * ((outreachPct * 4 + hoursPct * 3) / 7)),
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

// A day is active when the owner did something they control: worked hours,
// touched a new prospect, or followed up. Replies and meetings are outcomes.
function isActiveDay(counts: ManualCounts, hours: number): boolean {
  return (
    hours > 0 ||
    newTouches(counts) > 0 ||
    counts.emailFollowUps + counts.linkedinMessages + counts.followUpsSent > 0
  );
}

// Weekday average row + board columns both run Monday → Sunday (the user works
// Mon–Sun, not Sun–Sat).
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Monday-first weekday index (0 = Mon … 6 = Sun) from a JS UTC day (0 = Sun).
function mondayIndex(utcDay: number): number {
  return (utcDay + 6) % 7;
}

function addTally(left: OutreachTally, right: OutreachTally): OutreachTally {
  return {
    touches: left.touches + right.touches,
    emails: left.emails + right.emails,
    connectionRequests: left.connectionRequests + right.connectionRequests,
  };
}

const ZERO_TALLY: OutreachTally = {
  touches: 0,
  emails: 0,
  connectionRequests: 0,
};

/**
 * Builds the whole ledger from stored facts: day bars, scores, week totals,
 * charts, streaks, follow-ups due, and the outreach pipeline.
 *
 * Preconditions: `days` is ascending and contiguous; `today` and `rangeStart`
 * are day keys. Days outside [rangeStart, today] are alignment padding and
 * carry no counts. Postcondition: every derived value comes from this one
 * function, so the board, the day report, the overlay, and the Telegram ladder
 * cannot disagree.
 */
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

  // One goal lookup per week, reused by that week's day bars and by its own
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

  // A real elapsed day inside the data window. Days before the first data point
  // or after today are only alignment padding for the Monday grid.
  const facts = days.map((day) => {
    const inRange = day >= rangeStart && day <= today;
    const entry = inRange ? entries.get(day) : undefined;
    return { day, inRange, entry, ...readManualCounts(entry ?? {}) };
  });
  const splitStart = splitStartDay(facts);

  let loggedEarlier = ZERO_TALLY;
  let tallyWeek: string | null = null;
  const ledgerDays: LedgerDay[] = facts.map((fact, position) => {
    const { day, inRange, entry } = fact;
    const at = new Date(`${day}T12:00:00Z`);
    const state: DayState =
      day < today ? "past" : day === today ? "today" : "future";
    const weekStart = weekStartForDay(day);
    if (weekStart !== tallyWeek) {
      tallyWeek = weekStart;
      loggedEarlier = ZERO_TALLY;
    }
    const counts = readManualCounts(fact);
    const hours = inRange ? (hoursByDay.get(day) ?? 0) : 0;
    const weekly = weeklyTargetsFor(day);
    const targets: DailyTargets = {
      outreach: dailyOutreachBar(weekly.outreach, loggedEarlier, day),
      hours: weekly.hours / 7,
    };
    const tally = outreachTally(counts);
    loggedEarlier = addTally(loggedEarlier, tally);
    return {
      ...counts,
      day,
      index: position + 1,
      label: monthDayFormat.format(at),
      dayOfMonth: at.getUTCDate(),
      weekdayLabel: weekdayFormat.format(at),
      monthKey: day.slice(0, 7),
      monthLabel: monthFormat.format(at),
      inRange,
      state,
      hours,
      featureDone: entry?.featureDone ?? false,
      commits: entry?.commits ?? 0,
      merges: entry?.merges ?? 0,
      targets,
      due: inRange ? followUpsDue(facts, position, splitStart) : null,
      dailyValue: inRange ? dailyValue(tally, hours, targets) : 0,
      active: inRange && isActiveDay(counts, hours),
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
    activeDayStreak: activeDayStreak(elapsedDays),
    touchesSum: elapsedDays.reduce((sum, d) => sum + newTouches(d), 0),
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
    funnel: buildOutreachFunnel(facts, today),
    totals,
  };
}

function buildWeek(weekDays: LedgerDay[], goal: WeeklyTargets): LedgerWeek {
  const elapsedDays = weekDays.filter((d) => d.inRange);
  const counts = readManualCounts({});
  for (const day of elapsedDays) {
    for (const field of Object.keys(counts) as (keyof ManualCounts)[]) {
      counts[field] += day[field];
    }
  }
  const hours =
    Math.round(elapsedDays.reduce((sum, d) => sum + d.hours, 0) * 10) / 10;
  const commits = elapsedDays.reduce((sum, d) => sum + d.commits, 0);
  const merges = elapsedDays.reduce((sum, d) => sum + d.merges, 0);
  const startLabel = weekDays[0].label;
  const endLabel = weekDays[weekDays.length - 1].label;
  const progress = weeklyProgress(outreachTally(counts), hours, goal);
  return {
    weekStart: weekDays[0].day,
    weekEnd: weekDays[weekDays.length - 1].day,
    label: `${startLabel}–${endLabel}`,
    counts,
    touches: newTouches(counts),
    hours,
    commits,
    merges,
    goal,
    ...progress,
    days: weekDays,
  };
}

/** The stored facts of one assembled day, as an entry `assembleLedger` accepts. */
export function ledgerEntryFromDay(day: LedgerDay): LedgerEntry {
  return {
    ...readManualCounts(day),
    day: day.day,
    featureDone: day.featureDone,
    commits: day.commits,
    merges: day.merges,
  };
}

/** The goal each assembled week was measured against, in stored form. */
export function ledgerWeeklyGoals(data: LedgerData): WeeklyGoal[] {
  return data.weeks.map((week) =>
    storedWeeklyGoal(week.weekStart, week.goal.outreach, week.goal.hours),
  );
}

/**
 * Rebuilds a ledger from its own stored facts plus per-day patches, through
 * `assembleLedger`. The deployed overlay and the day report's unsaved drafts
 * both use this one path, so a draft and a saved value can never score
 * differently. Patches for days outside the data window are ignored; capture
 * fields (hours, commits, merges) cannot be patched. Input is not mutated.
 */
export function reassembleLedger(
  data: LedgerData,
  patches: Record<string, LedgerDayPatch> = {},
  goals: WeeklyGoal[] = ledgerWeeklyGoals(data),
): LedgerData {
  const entries = new Map<string, LedgerEntry>();
  const hoursByDay = new Map<string, number>();
  for (const day of data.days) {
    if (!day.inRange) {
      continue;
    }
    entries.set(day.day, { ...ledgerEntryFromDay(day), ...patches[day.day] });
    hoursByDay.set(day.day, day.hours);
  }
  const rangeStart = data.days.find((day) => day.inRange)?.day ?? data.today;
  return assembleLedger(
    data.days.map((day) => day.day),
    entries,
    hoursByDay,
    data.today,
    rangeStart,
    goals,
  );
}
