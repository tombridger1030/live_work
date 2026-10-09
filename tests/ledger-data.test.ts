import { expect, test } from "bun:test";
import {
  assembleLedger,
  dailyValue,
  weeklyProgress,
  hoursFromPresent,
  dayRange,
  activeDayStreak,
  reassembleLedger,
  resolveWeeklyGoal,
  WEEKLY_REACHOUT_TARGET,
  WEEKLY_HOURS_TARGET,
  type DailyTargets,
} from "@/lib/ledger";
import type { OutreachTally } from "@/lib/outreach-pace";
import type { LedgerEntry, WeeklyGoal } from "@/lib/types";

const touches = (count: number): OutreachTally => ({
  touches: count,
  emails: 0,
  connectionRequests: 0,
});

// A weekday bar of 50 touches and 10 hours.
const WEEKDAY: DailyTargets = {
  outreach: { kind: "touches", touches: 50 },
  hours: 10,
};

function entry(day: string, fields: Partial<LedgerEntry> = {}): LedgerEntry {
  return { day, featureDone: false, commits: 0, merges: 0, ...fields };
}

test("legacy feature flags survive without affecting activity, charts, or streaks", () => {
  const days = dayRange("2026-08-03", "2026-08-09");
  const build = (featureDone: boolean) =>
    assembleLedger(
      days,
      new Map(
        days.map((day) => [day, entry(day, { featureDone, reachouts: 0 })]),
      ),
      new Map(),
      days[6],
      days[0],
    );
  const legacy = build(true);
  const empty = build(false);
  expect(legacy.days.every((day) => day.featureDone)).toBe(true);
  expect(legacy.days.every((day) => day.dailyValue === 0 && !day.active)).toBe(
    true,
  );
  expect(legacy.totals).toEqual(empty.totals);
  expect(legacy.totals.activeDayStreak).toBe(0);
  expect(legacy.dailyChart).toEqual(empty.dailyChart);
  expect(legacy.weeklyChart).toEqual(empty.weeklyChart);
  expect(legacy.weekdayAverages).toEqual(empty.weekdayAverages);
});

test("weekly activity weights outreach 4/7 and hours 3/7 with independent caps", () => {
  expect(weeklyProgress(touches(250), 0).weeklyValue).toBe(57);
  expect(weeklyProgress(touches(0), 70).weeklyValue).toBe(43);
  expect(weeklyProgress(touches(125), 35).weeklyValue).toBe(50);
  expect(weeklyProgress(touches(250000), 0).weeklyValue).toBe(57);
  expect(weeklyProgress(touches(250), 70).weeklyValue).toBe(100);
  expect(
    weeklyProgress(touches(0), 0, {
      outreach: { kind: "touches", touches: 0 },
      hours: 0,
    }),
  ).toEqual({
    outreachPct: 1,
    hoursPct: 1,
    weeklyValue: 100,
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

test("a weekday weights outreach 4/7 and hours 3/7, with independent caps", () => {
  expect(dailyValue(touches(0), 0, WEEKDAY)).toBe(0);
  expect(dailyValue(touches(50), 0, WEEKDAY)).toBe(57);
  expect(dailyValue(touches(0), 10, WEEKDAY)).toBe(43);
  expect(dailyValue(touches(50), 10, WEEKDAY)).toBe(100);
  expect(dailyValue(touches(50000), 0, WEEKDAY)).toBe(57);
  expect(dailyValue(touches(0), 10000, WEEKDAY)).toBe(43);
  expect(dailyValue(touches(25), 5, WEEKDAY)).toBe(50);
});

test("a weekend is scored on hours alone, never on a free outreach share", () => {
  const weekend: DailyTargets = { outreach: null, hours: 10 };
  expect(dailyValue(touches(0), 0, weekend)).toBe(0);
  expect(dailyValue(touches(0), 5, weekend)).toBe(50);
  expect(dailyValue(touches(40), 10, weekend)).toBe(100);
});

test("the reported week: 150 goal, 42 sent Mon-Wed, Thursday asks for 54", () => {
  const days = dayRange("2026-10-05", "2026-10-11");
  const entries = new Map<string, LedgerEntry>([
    ["2026-10-05", entry("2026-10-05", { reachouts: 22 })],
    ["2026-10-06", entry("2026-10-06", { reachouts: 20 })],
    ["2026-10-08", entry("2026-10-08", { reachouts: 12 })],
  ]);
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-10-05", reachouts: 150, hours: 55 },
  ];
  const data = assembleLedger(
    days,
    entries,
    new Map(),
    "2026-10-09",
    "2026-10-05",
    goals,
  );
  const bars = data.days.map((day) => day.targets.outreach);
  expect(bars).toEqual([
    { kind: "touches", touches: 30 }, // Monday: 150 / 5
    { kind: "touches", touches: 32 }, // 128 left / 4
    { kind: "touches", touches: 36 }, // 108 left / 3
    { kind: "touches", touches: 54 }, // 108 left / 2: the number the owner expected
    { kind: "touches", touches: 96 }, // Friday inherits whatever Thursday left
    null,
    null,
  ]);
  expect(data.weeks[0].touches).toBe(54);
});

test("a channel week paces emails and requests separately; unsplit touches do not count toward them", () => {
  const days = dayRange("2026-10-12", "2026-10-18");
  const entries = new Map<string, LedgerEntry>([
    [
      "2026-10-12",
      entry("2026-10-12", {
        emailsSent: 20,
        connectionRequests: 4,
        reachouts: 30,
      }),
    ],
  ]);
  const goals: WeeklyGoal[] = [
    {
      weekStart: "2026-10-12",
      reachouts: 150,
      hours: 55,
      emails: 100,
      connectionRequests: 50,
    },
  ];
  const data = assembleLedger(
    days,
    entries,
    new Map([["2026-10-12", 55 / 7]]),
    "2026-10-13",
    "2026-10-12",
    goals,
  );
  const [monday, tuesday] = data.days;
  expect(monday.targets.outreach).toEqual({
    kind: "channels",
    emails: 20,
    connectionRequests: 10,
  });
  expect(tuesday.targets.outreach).toEqual({
    kind: "channels",
    emails: 20,
    connectionRequests: 12,
  });
  // Emails met (20/20), requests 4/10: (20 + 4) / 30 of the outreach share, full hours.
  expect(monday.dailyValue).toBe(Math.round(100 * (((24 / 30) * 4 + 3) / 7)));
  expect(data.weeks[0].goal.outreach).toEqual({
    kind: "channels",
    emails: 100,
    connectionRequests: 50,
  });
});

test("assembleLedger aggregates Monday-through-Sunday weekly goals", () => {
  const days = dayRange("2026-06-22", "2026-06-28");
  const entries = new Map<string, LedgerEntry>();
  [35, 35, 36, 36, 36, 36, 36].forEach((reachouts, index) =>
    entries.set(
      days[index],
      entry(days[index], { reachouts, featureDone: true }),
    ),
  );
  const hoursByDay = new Map(days.map((day) => [day, 10]));
  const data = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-07-10",
    "2026-06-22",
  );
  expect(data.weeks.length).toBe(1);
  const week = data.weeks[0];
  expect(week.touches).toBe(WEEKLY_REACHOUT_TARGET);
  expect(week.hours).toBe(WEEKLY_HOURS_TARGET);
  expect(week.outreachPct).toBe(1);
  expect(week.hoursPct).toBe(1);
  expect(week.weeklyValue).toBe(100);
  // Board columns run Monday → Sunday.
  expect(data.weekdayAverages[0].weekday).toBe("Mon");
  expect(data.weekdayAverages[6].weekday).toBe("Sun");
});

test("weekly targets stay historical while unsaved gaps inherit the latest earlier goal", () => {
  const days = dayRange("2026-06-22", "2026-07-12");
  const entries = new Map<string, LedgerEntry>(
    days.map((day) => [day, entry(day, { reachouts: 0 })]),
  );
  const hoursByDay = new Map<string, number>();
  const weekly: [string, string, number, number][] = [
    ["2026-06-22", "2026-06-24", 100, 40],
    ["2026-06-29", "2026-07-01", 125, 50],
    ["2026-07-06", "2026-07-08", 200, 80],
  ];
  for (const [weekStart, day, reachouts, hours] of weekly) {
    entries.set(day, entry(day, { reachouts }));
    for (const weekDay of days
      .filter((candidate) => candidate >= weekStart)
      .slice(0, 7)) {
      hoursByDay.set(weekDay, hours / 7);
    }
  }
  const goals: WeeklyGoal[] = weekly.map(([weekStart, , reachouts, hours]) => ({
    weekStart,
    reachouts,
    hours,
  }));
  const data = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-07-12",
    "2026-06-22",
    goals,
  );

  expect(
    data.weeks.map((week) => [week.goal, week.outreachPct, week.hoursPct]),
  ).toEqual([
    [{ outreach: { kind: "touches", touches: 100 }, hours: 40 }, 1, 1],
    [{ outreach: { kind: "touches", touches: 125 }, hours: 50 }, 1, 1],
    [{ outreach: { kind: "touches", touches: 200 }, hours: 80 }, 1, 1],
  ]);
  expect(resolveWeeklyGoal("2026-07-13", [goals[2], goals[0]])).toEqual({
    outreach: { kind: "touches", touches: 200 },
    hours: 80,
  });
  expect(resolveWeeklyGoal("2026-07-01", [goals[2], goals[0]])).toEqual({
    outreach: { kind: "touches", touches: 100 },
    hours: 40,
  });
});

test("assembleLedger keeps raw goals visible while using dailyValue for color/trends", () => {
  const days = ["2026-06-24"];
  const entries = new Map<string, LedgerEntry>([
    ["2026-06-24", entry("2026-06-24", { reachouts: 50, featureDone: true })],
  ]);
  const data = assembleLedger(
    days,
    entries,
    new Map([["2026-06-24", 10]]),
    "2026-06-24",
    "2026-06-24",
  );
  expect(data.days[0].reachouts).toBe(50);
  expect(data.days[0].hours).toBe(10);
  expect(data.days[0].featureDone).toBe(true);
  expect(data.days[0].dailyValue).toBeGreaterThan(0);
});

test("activeDayStreak skips an inactive today but breaks on inactive past days", () => {
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "today", active: false },
    ]),
  ).toBe(3);
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "today", active: false },
    ]),
  ).toBe(2);
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: false },
      { state: "past", active: true },
      { state: "today", active: true },
    ]),
  ).toBe(2);
  expect(
    activeDayStreak([
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "past", active: true },
      { state: "future", active: false },
    ]),
  ).toBe(3);
  expect(
    activeDayStreak([
      { state: "past", active: false },
      { state: "today", active: false },
    ]),
  ).toBe(0);
});

test("a day is scored against its own week's goal, not a built-in default", () => {
  // With a 100-touch / 50-hour week saved, Monday asks for 100 / 5 = 20, never
  // the 250-touch default's 50.
  const days = dayRange("2026-08-03", "2026-08-09");
  const entries = new Map<string, LedgerEntry>([
    ["2026-08-03", entry("2026-08-03", { reachouts: 20 })],
  ]);
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-08-03", reachouts: 100, hours: 50 },
  ];
  const data = assembleLedger(
    days,
    entries,
    new Map([["2026-08-03", 50 / 7]]),
    "2026-08-03",
    "2026-08-03",
    goals,
  );
  const monday = data.days[0];
  expect(monday.targets.outreach).toEqual({ kind: "touches", touches: 20 });
  expect(monday.targets.hours).toBeCloseTo(50 / 7, 10);
  expect(monday.dailyValue).toBe(100);
});

test("hitting every weekday bar and the hours bar scores every day 100", () => {
  const days = dayRange("2026-07-27", "2026-08-02");
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-07-27", reachouts: 70, hours: 35 },
  ];
  const hoursByDay = new Map(days.map((day) => [day, 5]));
  // Monday's bar is 14; logging it exactly keeps every later bar at 14.
  const entries = new Map<string, LedgerEntry>(
    days.slice(0, 5).map((day) => [day, entry(day, { reachouts: 14 })]),
  );
  const data = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-08-02",
    "2026-07-27",
    goals,
  );
  expect(
    data.days.map((day) =>
      day.targets.outreach?.kind === "touches"
        ? day.targets.outreach.touches
        : null,
    ),
  ).toEqual([14, 14, 14, 14, 14, null, null]);
  expect(data.days.map((day) => day.dailyValue)).toEqual(
    new Array(7).fill(100),
  );
});

test("a later week's goal cannot move an earlier week's day or week scores", () => {
  const days = dayRange("2026-07-27", "2026-08-09");
  const entries = new Map<string, LedgerEntry>();
  const hoursByDay = new Map<string, number>();
  for (const day of days) {
    entries.set(day, entry(day, { reachouts: 10 }));
    hoursByDay.set(day, 5);
  }
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-07-27", reachouts: 70, hours: 35 },
    { weekStart: "2026-08-03", reachouts: 140, hours: 70 },
  ];
  const before = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-08-09",
    "2026-07-27",
    goals,
  );
  const after = assembleLedger(
    days,
    entries,
    hoursByDay,
    "2026-08-09",
    "2026-07-27",
    [...goals, { weekStart: "2026-08-10", reachouts: 1000, hours: 140 }],
  );
  expect(after.days.map((day) => [day.targets, day.dailyValue])).toEqual(
    before.days.map((day) => [day.targets, day.dailyValue]),
  );
  expect(after.weeks.map((week) => [week.goal, week.weeklyValue])).toEqual(
    before.weeks.map((week) => [week.goal, week.weeklyValue]),
  );
});

test("reassembling a ledger changes nothing, and a patch re-derives later bars in its week", () => {
  const days = dayRange("2026-10-05", "2026-10-11");
  const entries = new Map<string, LedgerEntry>([
    ["2026-10-05", entry("2026-10-05", { reachouts: 22, connections: 3 })],
  ]);
  const goals: WeeklyGoal[] = [
    { weekStart: "2026-10-05", reachouts: 150, hours: 55 },
  ];
  const data = assembleLedger(
    days,
    entries,
    new Map([["2026-10-05", 6]]),
    "2026-10-08",
    "2026-10-05",
    goals,
  );
  expect(reassembleLedger(data)).toEqual(data);

  const patched = reassembleLedger(data, { "2026-10-05": { reachouts: 60 } });
  expect(patched.days[0].reachouts).toBe(60);
  expect(patched.days[0].connections).toBe(3); // unpatched counts survive
  expect(patched.days[1].targets.outreach).toEqual({
    kind: "touches",
    touches: 23,
  }); // (150 - 60) / 4, rounded up
  expect(patched.days[0].hours).toBe(6);
});
