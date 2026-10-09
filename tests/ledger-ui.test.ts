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
  day: "2026-06-28",
  index: 1,
  label: "Jun 28",
  dayOfMonth: 28,
  weekdayLabel: "Sun",
  monthKey: "2026-06",
  monthLabel: "Jun",
  inRange: true,
  state: "today",
  hours: 10.5,
  featureDone: true,
  commits: 0,
  merges: 0,
  targets: { outreach: null, hours: 70 / 7 },
  due: null,
  dailyValue: 100,
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
    "Sun Jun 28: 100 activity points, 36 touches, 10.5 hours",
  );
  expect(ledgerDayAriaLabel({ ...sampleDay, state: "future" })).toBe(
    "Sun Jun 28, future day",
  );
  expect(ledgerDayAriaLabel({ ...sampleDay, featureDone: false })).toBe(ledgerDayAriaLabel(sampleDay));
});
