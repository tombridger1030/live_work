import { expect, test } from "bun:test";
import { assembleLedger, dailyValue, hoursFromPresent, dayRange, activeDayStreak, resolveWeeklyGoal, DAILY_REACHOUT_REFERENCE, DAILY_HOURS_REFERENCE, WEEKLY_REACHOUT_TARGET, WEEKLY_HOURS_TARGET, WEEKLY_FEATURE_TARGET } from "@/lib/ledger";
import type { LedgerEntry, WeeklyGoal } from "@/lib/types";

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

test("dailyValue uses reachouts 40 hours 30 feature 30", () => {
  // No work = 0
  expect(dailyValue(0, 0, false)).toBe(0);
  // Reachouts-only at daily reference = 40
  expect(dailyValue(DAILY_REACHOUT_REFERENCE, 0, false)).toBe(40);
  // Hours-only at daily reference = 30
  expect(dailyValue(0, DAILY_HOURS_REFERENCE, false)).toBe(30);
  // Feature-only = 30
  expect(dailyValue(0, 0, true)).toBe(30);
  // All three at reference = 100
  expect(dailyValue(DAILY_REACHOUT_REFERENCE, DAILY_HOURS_REFERENCE, true)).toBe(100);
  // Over-target still caps at 100
  expect(dailyValue(DAILY_REACHOUT_REFERENCE * 2, DAILY_HOURS_REFERENCE * 2, true)).toBe(100);
});

test("assembleLedger aggregates Monday-through-Sunday weekly goals", () => {
  // 2026-06-22 is a Monday; build one full Monday→Sunday week.
  const days = dayRange("2026-06-22", "2026-06-28");
  const entries = new Map<string, LedgerEntry>();
  // Fill with exact values that sum to weekly targets (250 reachouts, 70 hours, 7 features)
  entries.set(days[0], { day: days[0], reachouts: 35, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 });
  entries.set(days[1], { day: days[1], reachouts: 35, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 });
  entries.set(days[2], { day: days[2], reachouts: 36, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 });
  entries.set(days[3], { day: days[3], reachouts: 36, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 });
  entries.set(days[4], { day: days[4], reachouts: 36, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 });
  entries.set(days[5], { day: days[5], reachouts: 36, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 });
  entries.set(days[6], { day: days[6], reachouts: 36, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 });
  const hoursByDay = new Map<string, number>();
  for (const day of days) {
    hoursByDay.set(day, 10);
  }
  const data = assembleLedger(days, entries, hoursByDay, "2026-07-10", "2026-06-22");
  expect(data.weeks.length).toBe(1);
  const week = data.weeks[0];
  expect(week.reachouts).toBe(WEEKLY_REACHOUT_TARGET);
  expect(week.hours).toBe(WEEKLY_HOURS_TARGET);
  expect(week.features).toBe(WEEKLY_FEATURE_TARGET);
  expect(week.reachoutsPct).toBe(1);
  expect(week.hoursPct).toBe(1);
  expect(week.featuresPct).toBe(1);
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
    entries.set(day, { day, reachouts: 0, featureDone: false, replies: 0, meetings: 0, commits: 0, merges: 0 });
  }
  for (const [day, reachouts, hours] of [
    ["2026-06-24", 100, 40 / 7],
    ["2026-07-01", 125, 50 / 7],
    ["2026-07-08", 200, 80 / 7]
  ] as const) {
    entries.set(day, { ...entries.get(day)!, reachouts });
    const weekStart = day === "2026-06-24" ? "2026-06-22" : day === "2026-07-01" ? "2026-06-29" : "2026-07-06";
    for (const weekDay of dayRange(weekStart, `${weekStart === "2026-06-22" ? "2026-06-28" : weekStart === "2026-06-29" ? "2026-07-05" : "2026-07-12"}`)) {
      hoursByDay.set(weekDay, hours);
    }
  }
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-06-22", reachouts: 100, hours: 40 },
    { weekStart: "2026-06-29", reachouts: 125, hours: 50 },
    { weekStart: "2026-07-06", reachouts: 200, hours: 80 }
  ];
  const data = assembleLedger(days, entries, hoursByDay, "2026-07-12", "2026-06-22", goals);

  expect(data.weeks.map((week) => [week.reachoutsTarget, week.hoursTarget, week.reachoutsPct, week.hoursPct])).toEqual([
    [100, 40, 1, 1],
    [125, 50, 1, 1],
    [200, 80, 1, 1]
  ]);
  expect(resolveWeeklyGoal("2026-07-13", [goals[2], goals[0]])).toEqual({ reachouts: 200, hours: 80, features: 7 });
  expect(resolveWeeklyGoal("2026-07-01", [goals[2], goals[0]])).toEqual({ reachouts: 100, hours: 40, features: 7 });
});

test("assembleLedger keeps raw goals visible while using dailyValue for color/trends", () => {
  const days = ["2026-06-24"];
  const entries = new Map<string, LedgerEntry>([
    ["2026-06-24", { day: "2026-06-24", reachouts: 50, featureDone: true, replies: 0, meetings: 0, commits: 0, merges: 0 }]
  ]);
  const hoursByDay = new Map<string, number>([["2026-06-24", 10]]);
  const data = assembleLedger(days, entries, hoursByDay, "2026-06-24", "2026-06-24");
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
      { state: "today", active: false }
    ])
  ).toBe(3);
  // An in-progress today is skipped, not counted as a break.
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "today", active: false }
    ])
  ).toBe(2);
  // A past gap breaks the streak - counts backwards: today(active) + past(active) = 2, then hits gap
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: false },
      { state: "past", active: true },
      { state: "today", active: true }
    ])
  ).toBe(2);
  // Future days are ignored entirely - streak of 3 past days
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "future", active: false }
    ])
  ).toBe(3);
  // No active days
  expect(activeDayStreak([{ state: "past", active: false }, { state: "today", active: false }])).toBe(0);
});
