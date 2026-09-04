import { expect, test } from "bun:test";
import {
  assembleLedger,
  dailyTargets,
  dailyValue,
  weeklyProgress,
  hoursFromPresent,
  dayRange,
  activeDayStreak,
  resolveWeeklyGoal,
  WEEKLY_REACHOUT_TARGET,
  WEEKLY_HOURS_TARGET,
} from "@/lib/ledger";
import type { LedgerEntry, WeeklyGoal } from "@/lib/types";

// The bar a week of 250 messages / 70 hours implies for one day.
const DEFAULT_DAILY = dailyTargets({
  reachouts: WEEKLY_REACHOUT_TARGET,
  hours: WEEKLY_HOURS_TARGET,
});

test("legacy feature flags survive without affecting activity, charts, or streaks", () => {
  const days = dayRange("2026-08-03", "2026-08-09");
  const build = (featureDone: boolean) => assembleLedger(days, new Map(days.map((day) => [day, {
    day, featureDone, reachouts: 0, replies: 0, meetings: 0, commits: 0, merges: 0,
  }])), new Map(), days[6], days[0]);
  const legacy = build(true);
  const empty = build(false);
  expect(legacy.days.every((day) => day.featureDone)).toBe(true);
  expect(legacy.days.every((day) => day.dailyValue === 0 && !day.active)).toBe(true);
  expect(legacy.totals).toEqual(empty.totals);
  expect(legacy.totals.activeDayStreak).toBe(0);
  expect(legacy.dailyChart).toEqual(empty.dailyChart);
  expect(legacy.weeklyChart).toEqual(empty.weeklyChart);
  expect(legacy.weekdayAverages).toEqual(empty.weekdayAverages);
});

test("weekly activity uses the daily contract including independently capped targets", () => {
  expect(weeklyProgress(250, 0).weeklyValue).toBe(57);
  expect(weeklyProgress(0, 70).weeklyValue).toBe(43);
  expect(weeklyProgress(125, 35).weeklyValue).toBe(50);
  expect(weeklyProgress(250000, 0).weeklyValue).toBe(57);
  expect(weeklyProgress(250, 70).weeklyValue).toBe(100);
  expect(weeklyProgress(0, 0, { reachouts: 0, hours: 0 })).toEqual({
    reachoutsPct: 1, hoursPct: 1, weeklyValue: 100,
  });
});

test("dayRange returns inclusive consecutive days", () => {
  // 2026-06-22 is a Monday, 2026-06-28 the following Sunday.
  const days = dayRange("2026-06-22", "2026-06-28");
  expect(days.length).toBe(7);
  expect(days[0]).toBe("2026-06-22");
  expect(days[6]).toBe("2026-06-28");
  expect(new Date(`${days[0]}T12:00:00Z`).getUTCDay()).toBe(1); // Monday
  expect(new Date(`${days[6]}T12:00:00Z`).getUTCDay()).toBe(0); // Sunday
});

test("hoursFromPresent converts present snapshots to hours", () => {
  expect(hoursFromPresent(144)).toBe(12); // 144 snapshots * 5min = 720min = 12h
  expect(hoursFromPresent(0)).toBe(0);
  expect(hoursFromPresent(6)).toBe(0.5);
});

test("activity weights reachouts 4/7 and hours 3/7, with independent caps", () => {
  expect(dailyValue(0, 0, DEFAULT_DAILY)).toBe(0);
  expect(dailyValue(DEFAULT_DAILY.reachouts, 0, DEFAULT_DAILY)).toBe(57);
  expect(dailyValue(0, DEFAULT_DAILY.hours, DEFAULT_DAILY)).toBe(43);
  expect(dailyValue(DEFAULT_DAILY.reachouts, DEFAULT_DAILY.hours, DEFAULT_DAILY)).toBe(100);
  expect(dailyValue(DEFAULT_DAILY.reachouts * 1000, 0, DEFAULT_DAILY)).toBe(57);
  expect(dailyValue(0, DEFAULT_DAILY.hours * 1000, DEFAULT_DAILY)).toBe(43);
  expect(dailyValue(DEFAULT_DAILY.reachouts / 2, DEFAULT_DAILY.hours / 2, DEFAULT_DAILY)).toBe(50);
});

test("assembleLedger aggregates Monday-through-Sunday weekly goals", () => {
  // 2026-06-22 is a Monday; build one full Monday→Sunday week.
  const days = dayRange("2026-06-22", "2026-06-28");
  const entries = new Map<string, LedgerEntry>();
  // Fill with exact values that sum to weekly targets (250 reachouts, 70 hours)
  entries.set(days[0], {
    day: days[0],
    reachouts: 35,
    featureDone: true,
    replies: 0,
    meetings: 0,
    commits: 0,
    merges: 0,
  });
  entries.set(days[1], {
    day: days[1],
    reachouts: 35,
    featureDone: true,
    replies: 0,
    meetings: 0,
    commits: 0,
    merges: 0,
  });
  entries.set(days[2], {
    day: days[2],
    reachouts: 36,
    featureDone: true,
    replies: 0,
    meetings: 0,
    commits: 0,
    merges: 0,
  });
  entries.set(days[3], {
    day: days[3],
    reachouts: 36,
    featureDone: true,
    replies: 0,
    meetings: 0,
    commits: 0,
    merges: 0,
  });
  entries.set(days[4], {
    day: days[4],
    reachouts: 36,
    featureDone: true,
    replies: 0,
    meetings: 0,
    commits: 0,
    merges: 0,
  });
  entries.set(days[5], {
    day: days[5],
    reachouts: 36,
    featureDone: true,
    replies: 0,
    meetings: 0,
    commits: 0,
    merges: 0,
  });
  entries.set(days[6], {
    day: days[6],
    reachouts: 36,
    featureDone: true,
    replies: 0,
    meetings: 0,
    commits: 0,
    merges: 0,
  });
  const hoursByDay = new Map<string, number>();
  for (const day of days) {
    hoursByDay.set(day, 10);
  }
  const data = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-07-10",
    "2026-06-22",
  );
  expect(data.weeks.length).toBe(1);
  const week = data.weeks[0];
  expect(week.reachouts).toBe(WEEKLY_REACHOUT_TARGET);
  expect(week.hours).toBe(WEEKLY_HOURS_TARGET);
  expect(week.reachoutsPct).toBe(1);
  expect(week.hoursPct).toBe(1);
  expect(week.weeklyValue).toBe(100);
  // Board columns run Monday → Sunday.
  expect(data.weekdayAverages[0].weekday).toBe("Mon");
  expect(data.weekdayAverages[6].weekday).toBe("Sun");
});

test("weekly targets stay historical while unsaved gaps inherit the latest earlier goal", () => {
  const days = dayRange("2026-06-22", "2026-07-12");
  const entries = new Map<string, LedgerEntry>();
  const hoursByDay = new Map<string, number>();
  for (const day of days) {
    entries.set(day, {
      day,
      reachouts: 0,
      featureDone: false,
      replies: 0,
      meetings: 0,
      commits: 0,
      merges: 0,
    });
  }
  for (const [day, reachouts, hours] of [
    ["2026-06-24", 100, 40 / 7],
    ["2026-07-01", 125, 50 / 7],
    ["2026-07-08", 200, 80 / 7],
  ] as const) {
    entries.set(day, { ...entries.get(day)!, reachouts });
    const weekStart =
      day === "2026-06-24"
        ? "2026-06-22"
        : day === "2026-07-01"
          ? "2026-06-29"
          : "2026-07-06";
    for (const weekDay of dayRange(
      weekStart,
      `${weekStart === "2026-06-22" ? "2026-06-28" : weekStart === "2026-06-29" ? "2026-07-05" : "2026-07-12"}`,
    )) {
      hoursByDay.set(weekDay, hours);
    }
  }
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-06-22", reachouts: 100, hours: 40 },
    { weekStart: "2026-06-29", reachouts: 125, hours: 50 },
    { weekStart: "2026-07-06", reachouts: 200, hours: 80 },
  ];
  const data = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-07-12",
    "2026-06-22",
    goals,
  );

  expect(
    data.weeks.map((week) => [
      week.reachoutsTarget,
      week.hoursTarget,
      week.reachoutsPct,
      week.hoursPct,
    ]),
  ).toEqual([
    [100, 40, 1, 1],
    [125, 50, 1, 1],
    [200, 80, 1, 1],
  ]);
  expect(resolveWeeklyGoal("2026-07-13", [goals[2], goals[0]])).toEqual({
    reachouts: 200,
    hours: 80,
  });
  expect(resolveWeeklyGoal("2026-07-01", [goals[2], goals[0]])).toEqual({
    reachouts: 100,
    hours: 40,
  });
});

test("assembleLedger keeps raw goals visible while using dailyValue for color/trends", () => {
  const days = ["2026-06-24"];
  const entries = new Map<string, LedgerEntry>([
    [
      "2026-06-24",
      {
        day: "2026-06-24",
        reachouts: 50,
        featureDone: true,
        replies: 0,
        meetings: 0,
        commits: 0,
        merges: 0,
      },
    ],
  ]);
  const hoursByDay = new Map<string, number>([["2026-06-24", 10]]);
  const data = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-06-24",
    "2026-06-24",
  );
  expect(data.days[0].reachouts).toBe(50);
  expect(data.days[0].hours).toBe(10);
  expect(data.days[0].featureDone).toBe(true);
  expect(data.days[0].dailyValue).toBeGreaterThan(0);
});

test("activeDayStreak skips an inactive today but breaks on inactive past days", () => {
  // Streak of 3 active days, today inactive - today is skipped, counts backwards from yesterday
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "today", active: false },
    ]),
  ).toBe(3);
  // An in-progress today is skipped, not counted as a break.
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "today", active: false },
    ]),
  ).toBe(2);
  // A past gap breaks the streak - counts backwards: today(active) + past(active) = 2, then hits gap
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: false },
      { state: "past", active: true },
      { state: "today", active: true },
    ]),
  ).toBe(2);
  // Future days are ignored entirely - streak of 3 past days
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "future", active: false },
    ]),
  ).toBe(3);
  // No active days
  expect(
    activeDayStreak([
      { state: "past", active: false },
      { state: "today", active: false },
    ]),
  ).toBe(0);
});

test("a day is scored against its own week's goal, not a built-in default", () => {
  // The reported bug: with a 100-message / 50-hour week saved, the day panel
  // still showed the 250/70 defaults (36 messages, 10.0 hours).
  const days = dayRange("2026-08-03", "2026-08-09");
  const entries = new Map<string, LedgerEntry>([
    ["2026-08-03", { day: "2026-08-03", reachouts: 15, featureDone: false, replies: 0, meetings: 0, commits: 0, merges: 0 }]
  ]);
  const hoursByDay = new Map<string, number>([["2026-08-03", 50 / 7]]);
  const goals: WeeklyGoal[] = [{ weekStart: "2026-08-03", reachouts: 100, hours: 50 }];
  const data = assembleLedger(days, entries, hoursByDay, "2026-08-03", "2026-08-03", goals);

  const monday = data.days[0];
  expect(monday.targets.reachouts).toBeCloseTo(100 / 7, 10); // shows as "/ 14", never "/ 36"
  expect(monday.targets.hours).toBeCloseTo(50 / 7, 10); // shows as "/ 7.1", never "/ 10.0"
  // 15 messages clears a 14.3 bar, so the activity targets are both met.
  expect(monday.dailyValue).toBe(100);
});

test("a later week's goal cannot move an earlier week's day or week scores", () => {
  // Raising next week's bar must not re-score the week already worked, or
  // week-over-week improvement measures nothing.
  const days = dayRange("2026-07-27", "2026-08-09"); // two full Mon-Sun weeks
  const entries = new Map<string, LedgerEntry>();
  const hoursByDay = new Map<string, number>();
  for (const day of days) {
    entries.set(day, { day, reachouts: 10, featureDone: false, replies: 0, meetings: 0, commits: 0, merges: 0 });
    hoursByDay.set(day, 5);
  }
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-07-27", reachouts: 70, hours: 35 }, // daily bar 10 messages / 5h
    { weekStart: "2026-08-03", reachouts: 140, hours: 70 } // daily bar 20 messages / 10h
  ];
  const before = assembleLedger(days, entries, hoursByDay, "2026-08-09", "2026-07-27", goals);

  // Same logged work, different bar per week: at bar = 100, at half bar = 50.
  expect(before.weeks[0].days.map((day) => day.dailyValue)).toEqual(new Array(7).fill(100));
  expect(before.weeks[1].days.map((day) => day.dailyValue)).toEqual(new Array(7).fill(50));

  // Now set a far higher goal for the FOLLOWING week and re-assemble.
  const after = assembleLedger(days, entries, hoursByDay, "2026-08-09", "2026-07-27", [
    ...goals,
    { weekStart: "2026-08-10", reachouts: 1000, hours: 140 }
  ]);
  expect(after.days.map((day) => day.dailyValue)).toEqual(before.days.map((day) => day.dailyValue));
  expect(after.weeks.map((week) => [week.reachoutsTarget, week.hoursTarget, week.weeklyValue])).toEqual(
    before.weeks.map((week) => [week.reachoutsTarget, week.hoursTarget, week.weeklyValue])
  );
});
