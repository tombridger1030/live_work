import { expect, test } from "bun:test";
import {
  assembleLedger,
  creditedHours,
  dailyScore,
  dayRange,
  EMAIL_BONUS_MAX_POINTS,
  reassembleLedger,
  weeklyProgress,
  type DailyTargets,
} from "@/lib/ledger";
import { readManualCounts, type ManualCounts } from "@/lib/ledger-fields";
import { splitStartDay } from "@/lib/outreach-funnel";
import type { LedgerEntry, WeeklyGoal } from "@/lib/types";
import { outreachGoalUnit } from "@/lib/outreach-pace";
import { connectionRequestGoal } from "@/lib/weekly-goal";

// The owner's counts for Oct 5-13, 2026, as the live ledger showed them on
// Oct 13. Oct 5-11 kept its email goal; Oct 12-18 is a requests-only week.
const LOGGED: Record<string, Partial<ManualCounts>> = {
  "2026-10-05": { connectionRequests: 22, connections: 2 },
  "2026-10-06": { connectionRequests: 20, connections: 8, linkedinMessages: 3 },
  "2026-10-07": { connections: 4 },
  "2026-10-08": { reachouts: 12, connectionRequests: 12, connections: 4 },
  "2026-10-09": { connectionRequests: 54, connections: 15 },
  "2026-10-10": { connections: 2 },
  "2026-10-11": { connections: 1 },
  "2026-10-12": { connectionRequests: 50, connections: 10 },
  "2026-10-13": {
    connectionRequests: 50,
    connections: 8,
    linkedinMessages: 22,
    linkedinReplies: 1,
  },
};

const GOALS: WeeklyGoal[] = [
  {
    weekStart: "2026-10-05",
    reachouts: 150,
    hours: 55,
    emails: 50,
    connectionRequests: 100,
  },
  connectionRequestGoal("2026-10-12", 250, 55),
];

function ownersLedger(extra: Record<string, Partial<ManualCounts>> = {}) {
  const days = dayRange("2026-10-05", "2026-10-18");
  const entries = new Map<string, LedgerEntry>(
    Object.entries(LOGGED).map(([day, counts]) => [
      day,
      {
        day,
        featureDone: false,
        commits: 0,
        merges: 0,
        ...counts,
        ...extra[day],
      },
    ]),
  );
  return assembleLedger(
    days,
    entries,
    new Map([["2026-10-13", 2.8]]),
    "2026-10-13",
    "2026-10-05",
    GOALS,
  );
}

test("Oct 12 and 13 score 38 and 58: requests, first messages owed, and replies owed", () => {
  const ledger = ownersLedger();
  const [monday, tuesday] = ledger.days.slice(7, 9);
  expect(monday.sends).toEqual({
    firstTouches: { required: 50, done: 50 },
    secondTouches: { required: 43, done: 0 },
    replies: { required: 0, done: 0 },
  });
  expect(monday.scoreParts).toEqual({ goals: 38, hours: 0 }); // 50 of 93
  expect(tuesday.sends).toEqual({
    firstTouches: { required: 50, done: 50 },
    secondTouches: { required: 51, done: 22 },
    replies: { required: 1, done: 0 },
  });
  expect(tuesday.scoreParts).toEqual({ goals: 49, hours: 9 }); // 72 of 102; 2.8 of a 9.2-hour bar
  expect(tuesday.dailyValue).toBe(58);
  // The chart reads the same split it draws as stacked bars.
  const chartTuesday = ledger.dailyChart.find((point) => point.day === "2026-10-13");
  expect(chartTuesday?.scoreParts).toEqual({ goals: 49, hours: 9 });
  expect(ledger.weeks[1].scoreParts.goals + ledger.weeks[1].scoreParts.hours).toBe(ledger.weeks[1].baseValue);
  expect(ledger.days[12].sends).toBeNull(); // Saturday owes nothing scored
});

test("email follow-ups stay a to-do, and no kind of send covers another", () => {
  const bar: DailyTargets = {
    outreach: { kind: "channels", emails: 0, connectionRequests: 50 },
    hours: 10,
  };
  const due = {
    emailFollowUps: 12,
    linkedinMessages: 4,
    emailRepliesAnswered: 6,
    linkedinRepliesAnswered: 4,
  };
  const score = (counts: Partial<ManualCounts>) =>
    dailyScore(readManualCounts(counts), 0, bar, due).goals;
  expect(score({ connectionRequests: 50 })).toBe(55); // 50 of 64
  expect(
    score({
      connectionRequests: 50,
      linkedinMessages: 4,
      emailRepliesAnswered: 6,
      linkedinRepliesAnswered: 4,
    }),
  ).toBe(70);
  expect(score({ connectionRequests: 50, emailFollowUps: 12 })).toBe(55); // follow-ups earn nothing
  expect(score({ connectionRequests: 50, linkedinMessages: 10 })).toBe(59); // 54 of 64: extra messages cover no replies
  expect(score({ connectionRequests: 90 })).toBe(55); // extra requests cover no messages
  expect(score({ connectionRequests: 50, emailsSent: 30 })).toBe(55); // bonus emails never move a day
});

test("away-from-desk time counts half, and reassembly never counts it twice", () => {
  const ledger = ownersLedger({ "2026-10-12": { awayMinutes: 180 } });
  const monday = ledger.days[7];
  expect(monday.hours).toBe(0); // desk hours, from captures only
  expect(monday.creditedHours).toBe(1.5);
  expect(monday.scoreParts).toEqual({ goals: 38, hours: 6 }); // 1.5 of a 7.9-hour bar
  expect(ledger.weeks[1].creditedHours).toBe(4.3);
  expect(reassembleLedger(ledger)).toEqual(ledger);
  expect(creditedHours(2.8, 45)).toBeCloseTo(3.175, 10);
  expect(creditedHours(0, 0)).toBe(0);
});

test("emails are bonus on a week whose goal asks for none: +1 each, at most +10", () => {
  const base = ownersLedger();
  const withEmails = ownersLedger({ "2026-10-13": { emailsSent: 4 } });
  expect(withEmails.days[8].scoreParts).toEqual(base.days[8].scoreParts);
  expect(withEmails.weeks[1].emailBonus).toBe(4);
  expect(withEmails.weeks[1].baseValue).toBe(base.weeks[1].baseValue);
  expect(withEmails.weeks[1].weeklyValue).toBe(base.weeks[1].weeklyValue + 4);
  expect(
    ownersLedger({ "2026-10-13": { emailsSent: 25 } }).weeks[1].emailBonus,
  ).toBe(EMAIL_BONUS_MAX_POINTS);
  // A week whose goal still asks for emails counts them there, never twice.
  expect(
    ownersLedger({ "2026-10-06": { emailsSent: 5 } }).weeks[0].emailBonus,
  ).toBe(0);
  expect(
    weeklyProgress({ touches: 12, emails: 12, connectionRequests: 0 }, 0, {
      outreach: { kind: "touches", touches: 100 },
      hours: 55,
    }).emailBonus,
  ).toBe(0);
});

test("logging away time never starts the outreach pipeline", () => {
  const days = dayRange("2026-09-28", "2026-10-02").map((day) => ({
    day,
    inRange: true,
    ...readManualCounts({ awayMinutes: 120 }),
  }));
  expect(splitStartDay(days)).toBeNull();
});

test("chart rows carry the goals of their own week", () => {
  const ledger = ownersLedger();
  const monday = ledger.dailyChart.find((point) => point.day === "2026-10-12");
  expect(monday?.hoursTarget).toBe(7.9); // 55 h over the 7 days of Oct 12-18
  expect(monday?.sends.secondTouches).toEqual({ required: 43, done: 0 });
  // Oct 5-11 kept its email goal; Oct 12-18 asks for requests only.
  expect(ledger.weeks.map((week) => outreachGoalUnit(week.goal.outreach))).toEqual([
    "emails + requests",
    "requests",
  ]);
  expect(outreachGoalUnit({ kind: "touches", touches: 100 })).toBe("touches");
});
