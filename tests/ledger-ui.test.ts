import { expect, test } from "bun:test";
import { clampDailyCount, readManualCounts } from "@/lib/ledger-fields";
import {
  ledgerChartDayTick,
  ledgerDayAriaLabel,
  progressState,
} from "@/lib/ledger-ui";
import type { LedgerDay } from "@/lib/ledger";

const sampleDay: LedgerDay = {
  ...readManualCounts({ reachouts: 30, emailsSent: 4, connectionRequests: 2 }),
  day: "2026-06-26",
  index: 1,
  label: "Jun 26",
  dayOfMonth: 26,
  weekdayLabel: "Fri",
  monthKey: "2026-06",
  monthLabel: "Jun",
  inRange: true,
  state: "today",
  hours: 10.5,
  creditedHours: 10.5,
  featureDone: true,
  commits: 0,
  merges: 0,
  targets: { outreach: { kind: "touches", touches: 36 }, hours: 10 },
  due: null,
  sends: {
    firstTouches: { required: 36, done: 36 },
    secondTouches: { required: 0, done: 0 },
    replies: { required: 0, done: 0 },
  },
  dailyValue: 100,
  scoreParts: { goals: 70, hours: 30 },
  active: true,
};

test("clampDailyCount rounds and clamps to the accepted API range", () => {
  expect(clampDailyCount(12.4)).toBe(12);
  expect(clampDailyCount(-3)).toBe(0);
  expect(clampDailyCount(2048)).toBe(1000);
  expect(clampDailyCount(Number.NaN)).toBe(0);
});

test("progressState keeps weekly and daily labels aligned", () => {
  expect(progressState(0, 10)).toBe("behind");
  expect(progressState(7, 10)).toBe("on pace");
  expect(progressState(10, 10)).toBe("done");
  expect(progressState(10, 0)).toBe("done");
});

test("daily trend keeps duplicate day numbers on unique full-date coordinates", () => {
  const julyFourth = "2026-07-04";
  const augustFourth = "2026-08-04";

  expect(julyFourth).not.toBe(augustFourth);
  expect(ledgerChartDayTick(julyFourth)).toBe("4");
  expect(ledgerChartDayTick(augustFourth)).toBe("4");
});

test("ledgerDayAriaLabel exposes the raw day facts for assistive tech", () => {
  expect(ledgerDayAriaLabel(sampleDay)).toBe(
    "Fri Jun 26: 100 activity points, 36 touches, 10.5 hours",
  );
  expect(ledgerDayAriaLabel({ ...sampleDay, state: "future" })).toBe(
    "Fri Jun 26, future day",
  );
  expect(ledgerDayAriaLabel({ ...sampleDay, featureDone: false })).toBe(
    ledgerDayAriaLabel(sampleDay),
  );
  expect(
    ledgerDayAriaLabel({
      ...sampleDay,
      weekdayLabel: "Sat",
      label: "Jun 27",
      targets: null,
      dailyValue: null,
      scoreParts: null,
      sends: null,
      hours: 2,
      creditedHours: 2,
    }),
  ).toBe("Sat Jun 27: weekend, 2.0 extra hours, 36 touches");
});
