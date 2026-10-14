import {
  readManualCounts,
  newTouches,
  type ManualCounts,
} from "@/lib/ledger-fields";
import {
  buildOutreachFunnel,
  dueToday,
  splitStartDay,
  type DueToday,
  type OutreachFunnel,
} from "@/lib/outreach-funnel";
import {
  catchUpBar,
  countsEmails,
  dailyOutreachBar,
  outreachProgress,
  outreachRequirement,
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
 * One weekday's bars, each its catch-up share of its own week's goal (see
 * lib/outreach-pace.ts): outreach in whole messages over the weekdays left,
 * hours in tenths over every day left through Sunday (the weekly hours goal
 * includes the weekend). Weekends have no targets and no score; their hours
 * still count toward the week.
 */
export type DailyTargets = {
  outreach: OutreachGoal;
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
  hours: number; // at the desk, from captures; the hours input the mirror rebuilds from (creditedHours is derived)
  creditedHours: number; // what counts toward bars and score: desk hours plus credited away time
  featureDone: boolean; // Legacy stored data only; never contributes to activity.
  commits: number;
  merges: number;
  targets: DailyTargets | null; // this weekday's share of its week's goal; null on weekends
  due: DueToday | null; // follow-ups and answers this day owes; null before the split
  sends: DaySends | null; // what the goals share is earned from; null on weekends
  dailyValue: number | null; // null on weekends: extra work is never scored
  scoreParts: ScoreParts | null; // goals (of 70) + hours (of 30) = dailyValue; null on weekends
  active: boolean;
};

export type LedgerWeek = {
  weekStart: string;
  weekEnd: string;
  label: string;
  counts: ManualCounts; // every manual count summed over the week's elapsed days
  touches: number; // new-prospect touches: unsplit touches + emails + connection requests
  creditedHours: number; // summed day creditedHours: desk plus credited away time
  commits: number;
  merges: number;
  goal: WeeklyTargets; // the goal this week is measured against
  outreachPct: number;
  hoursPct: number;
  scoreParts: ScoreParts; // goals (of 70) + hours (of 30) = baseValue
  baseValue: number; // 0 to 100: goals plus hours, before the email bonus
  emailBonus: number; // 0 to EMAIL_BONUS_MAX_POINTS
  weeklyValue: number; // baseValue + emailBonus, 0 to 100 + EMAIL_BONUS_MAX_POINTS
  days: LedgerDay[];
};

export type LedgerData = {
  startDay: string;
  endDay: string;
  today: string;
  todayIndex: number | null;
  days: LedgerDay[];
  weeks: LedgerWeek[];
  dailyChart: {
    day: string;
    label: string;
    dailyValue: number;
    scoreParts: ScoreParts; // goals + hours = dailyValue
    sends: DaySends; // what the goals part was earned against, from the day's own bars
    creditedHours: number;
    hoursTarget: number; // the day's hours bar, from its own week's goal
    weekAverage: number | null; // mean of this and the previous four scored weekdays
  }[];
  weeklyChart: { weekStart: string; label: string; weeklyValue: number }[];
  funnel: OutreachFunnel;
  totals: {
    daysElapsed: number;
    activeDays: number;
    activeDayStreak: number;
    touchesSum: number;
    hoursSum: number; // credited hours
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

// Time away from the desk is logged by hand and assumed to be lower quality
// than camera-verified desk time (owner decision, 2026-10-13), so it counts
// at half.
export const AWAY_HOURS_CREDIT = 0.5;

/**
 * Hours that count toward a day's hours bar and the weekly hours goal.
 *
 * @param deskHours hours at the desk from captures, finite and >= 0
 * @param awayMinutes hand-logged minutes worked away from the desk, >= 0
 * @returns deskHours + AWAY_HOURS_CREDIT x awayMinutes / 60 (180 away minutes
 *   credit 1.5 hours). Unrounded, so a day with no away time scores exactly
 *   on its desk hours; displays and week totals round.
 */
export function creditedHours(deskHours: number, awayMinutes: number): number {
  return deskHours + (AWAY_HOURS_CREDIT * awayMinutes) / 60;
}

// The activity score's split: finishing every send the day requires earns the
// goals share, and the day's hours earn the rest. Single source of the weights.
export const GOALS_POINTS = 70;
export const HOURS_POINTS = 30;

// Emails are bonus on a week whose goal asks for none: this many points per
// email, up to EMAIL_BONUS_MAX_POINTS on top of the week's 100.
export const EMAIL_BONUS_POINTS_PER_EMAIL = 1;
export const EMAIL_BONUS_MAX_POINTS = 10;

/** A weekday's score in its two whole-number parts; they always add up to the total. */
export type ScoreParts = { goals: number; hours: number };

/** One kind of send a weekday requires. Invariant: 0 <= done <= required. */
export type SendProgress = { required: number; done: number };

/**
 * The sends a weekday's goals share is earned from. Each kind is capped at its
 * own number, so extra sends of one kind never cover another:
 * - firstTouches: new prospects against the day's outreach bar (connection
 *   requests, plus emails only in a week whose goal still asks for them).
 * - secondTouches: first LinkedIn messages owed to people who accepted.
 * - replies: answers owed to prospects who replied, email and LinkedIn.
 * Email follow-ups are a to-do, never a goal.
 */
export type DaySends = {
  firstTouches: SendProgress;
  secondTouches: SendProgress;
  replies: SendProgress;
};

function owed(sent: number, due: number): SendProgress {
  return { required: due, done: Math.min(sent, due) };
}

/**
 * What a weekday requires against its own outreach bar and what it owes
 * (`due`; null before the split, when nothing is owed), and how much of each
 * is done.
 */
export function daySends(
  counts: ManualCounts,
  outreachBar: OutreachGoal,
  due: DueToday | null,
): DaySends {
  const emailAnswers = owed(
    counts.emailRepliesAnswered,
    due?.emailRepliesAnswered ?? 0,
  );
  const linkedinAnswers = owed(
    counts.linkedinRepliesAnswered,
    due?.linkedinRepliesAnswered ?? 0,
  );
  return {
    firstTouches: outreachRequirement(outreachTally(counts), outreachBar),
    secondTouches: owed(counts.linkedinMessages, due?.linkedinMessages ?? 0),
    replies: {
      required: emailAnswers.required + linkedinAnswers.required,
      done: emailAnswers.done + linkedinAnswers.done,
    },
  };
}

/**
 * Scores a weekday 0-100 against that day's own bars.
 *
 * Goals (70 points): the share of every send in `daySends` that is done
 * (1st touches, 2nd touches, and replies owed, each capped at its own number).
 * Nothing required (ahead of pace, nothing owed) counts as done.
 * Hours (30 points): `hours` (credited hours) against the day's hours bar,
 * capped.
 *
 * Weekends are never scored. Outputs (accepts, replies received, meetings)
 * and bonus emails never touch a day's score; this does not measure code
 * velocity.
 */
export function dailyScore(
  counts: ManualCounts,
  hours: number,
  targets: DailyTargets,
  due: DueToday | null,
): ScoreParts {
  return scoreSends(daySends(counts, targets.outreach, due), hours, targets.hours);
}

// `dailyScore` from sends already worked out, so the score and the sends a
// day report shows come from one computation.
function scoreSends(sends: DaySends, hours: number, hoursBar: number): ScoreParts {
  const kinds = Object.values(sends);
  const required = kinds.reduce((sum, send) => sum + send.required, 0);
  const done = kinds.reduce((sum, send) => sum + send.done, 0);
  const goalsPct = required > 0 ? done / required : 1;
  return {
    goals: Math.round(GOALS_POINTS * goalsPct),
    hours: Math.round(HOURS_POINTS * hoursProgress(hours, hoursBar)),
  };
}

/** A weekday's total score: the sum of its `dailyScore` parts. */
export function dailyValue(
  counts: ManualCounts,
  hours: number,
  targets: DailyTargets,
  due: DueToday | null,
): number {
  const parts = dailyScore(counts, hours, targets, due);
  return parts.goals + parts.hours;
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

/**
 * Capped weekly progress, split like a weekday (goals 70, hours 30), plus the
 * email bonus. At week level the goals share is new outreach against the
 * weekly goal; 2nd touches and replies are judged day by day, where their due
 * counts exist. A goal that asks for no emails earns
 * EMAIL_BONUS_POINTS_PER_EMAIL per email sent, up to EMAIL_BONUS_MAX_POINTS:
 * `baseValue` runs 0 to 100 and `weeklyValue` (base plus bonus) 0 to 110.
 *
 * @param hours credited hours for the week
 */
export function weeklyProgress(
  tally: OutreachTally,
  hours: number,
  targets: WeeklyTargets = DEFAULT_WEEKLY_TARGETS,
) {
  const outreachPct = outreachProgress(tally, targets.outreach);
  const hoursPct = hoursProgress(hours, targets.hours);
  const emailBonus = countsEmails(targets.outreach)
    ? 0
    : Math.min(EMAIL_BONUS_MAX_POINTS, EMAIL_BONUS_POINTS_PER_EMAIL * tally.emails);
  const scoreParts: ScoreParts = {
    goals: Math.round(GOALS_POINTS * outreachPct),
    hours: Math.round(HOURS_POINTS * hoursPct),
  };
  const baseValue = scoreParts.goals + scoreParts.hours;
  return {
    outreachPct,
    hoursPct,
    scoreParts,
    baseValue,
    emailBonus,
    weeklyValue: baseValue + emailBonus,
  };
}

/**
 * Consecutive active days ending today (or yesterday, while today is still
 * empty). An idle rest day (a weekend) is skipped rather than breaking the
 * run; a worked one counts like any other active day.
 */
export function activeDayStreak(
  days: { state: DayState; active: boolean; restDay: boolean }[],
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
    const day = elapsed[index];
    if (day.active) {
      streak += 1;
    } else if (!day.restDay) {
      break;
    }
  }
  return streak;
}

// A day is active when the owner did something they control: worked hours,
// touched a new prospect, followed up, or answered a reply. Replies received
// and meetings are outcomes.
function isActiveDay(counts: ManualCounts, hours: number): boolean {
  return (
    hours > 0 ||
    newTouches(counts) > 0 ||
    counts.emailFollowUps +
      counts.linkedinMessages +
      counts.followUpsSent +
      counts.emailRepliesAnswered +
      counts.linkedinRepliesAnswered >
      0
  );
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
  let hoursEarlier = 0;
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
      hoursEarlier = 0;
    }
    const counts = readManualCounts(fact);
    const hours = inRange ? (hoursByDay.get(day) ?? 0) : 0;
    const credited = creditedHours(hours, counts.awayMinutes);
    const weekly = weeklyTargetsFor(day);
    const outreachBar = dailyOutreachBar(weekly.outreach, loggedEarlier, day);
    const hoursBar = catchUpBar(weekly.hours, hoursEarlier, day, {
      decimals: 1,
      spreadOver: "week",
    });
    const targets: DailyTargets | null =
      outreachBar === null || hoursBar === null
        ? null
        : { outreach: outreachBar, hours: hoursBar };
    const tally = outreachTally(counts);
    loggedEarlier = addTally(loggedEarlier, tally);
    hoursEarlier += credited;
    const due = inRange ? dueToday(facts, position, splitStart) : null;
    // Padding days inside a week (before the data, or after today) have bars
    // but nothing logged: no sends, and a zero score.
    const sends =
      targets !== null && inRange ? daySends(counts, targets.outreach, due) : null;
    const scoreParts: ScoreParts | null =
      targets === null
        ? null
        : sends === null
          ? { goals: 0, hours: 0 }
          : scoreSends(sends, credited, targets.hours);
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
      creditedHours: credited,
      featureDone: entry?.featureDone ?? false,
      commits: entry?.commits ?? 0,
      merges: entry?.merges ?? 0,
      targets,
      due,
      sends,
      dailyValue:
        scoreParts === null ? null : scoreParts.goals + scoreParts.hours,
      scoreParts,
      active: inRange && isActiveDay(counts, credited),
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

  // Scored days are in-range weekdays; weekends are extra work and never scored.
  const scoredDays = elapsedDays.flatMap((day) =>
    day.dailyValue === null ||
    day.scoreParts === null ||
    day.sends === null ||
    day.targets === null
      ? []
      : [
          {
            ...day,
            dailyValue: day.dailyValue,
            scoreParts: day.scoreParts,
            sends: day.sends,
            hoursTarget: day.targets.hours,
          },
        ],
  );

  // Daily chart: every scored weekday + the average of the last five (one week).
  const dailyChart = scoredDays.map((d, i) => {
    let weekAverage: number | null = null;
    if (i >= 4) {
      const window = scoredDays.slice(i - 4, i + 1);
      weekAverage = Math.round(
        window.reduce((sum, w) => sum + w.dailyValue, 0) / 5,
      );
    }
    return {
      day: d.day,
      label: d.label,
      dailyValue: d.dailyValue,
      scoreParts: d.scoreParts,
      sends: d.sends,
      creditedHours: d.creditedHours,
      hoursTarget: d.hoursTarget,
      weekAverage,
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
    activeDayStreak: activeDayStreak(
      elapsedDays.map((d) => ({
        state: d.state,
        active: d.active,
        restDay: d.targets === null,
      })),
    ),
    touchesSum: elapsedDays.reduce((sum, d) => sum + newTouches(d), 0),
    hoursSum: sumHours(elapsedDays),
  };

  return {
    startDay,
    endDay,
    today,
    todayIndex: todayDay?.index ?? null,
    days: ledgerDays,
    weeks,
    dailyChart,
    weeklyChart,
    funnel: buildOutreachFunnel(facts, today),
    totals,
  };
}

// Credited hours over some days, to a tenth of an hour.
function sumHours(days: LedgerDay[]): number {
  return (
    Math.round(days.reduce((sum, d) => sum + d.creditedHours, 0) * 10) / 10
  );
}

function buildWeek(weekDays: LedgerDay[], goal: WeeklyTargets): LedgerWeek {
  const elapsedDays = weekDays.filter((d) => d.inRange);
  const counts = readManualCounts({});
  for (const day of elapsedDays) {
    for (const field of Object.keys(counts) as (keyof ManualCounts)[]) {
      counts[field] += day[field];
    }
  }
  const credited = sumHours(elapsedDays);
  const commits = elapsedDays.reduce((sum, d) => sum + d.commits, 0);
  const merges = elapsedDays.reduce((sum, d) => sum + d.merges, 0);
  const startLabel = weekDays[0].label;
  const endLabel = weekDays[weekDays.length - 1].label;
  const progress = weeklyProgress(outreachTally(counts), credited, goal);
  return {
    weekStart: weekDays[0].day,
    weekEnd: weekDays[weekDays.length - 1].day,
    label: `${startLabel}–${endLabel}`,
    counts,
    touches: newTouches(counts),
    creditedHours: credited,
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
