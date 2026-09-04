import { expect, test } from "bun:test";
import {
  ledgerChartDayTick,
  ledgerDayAriaLabel,
  progressState,
  clampReachouts,
} from "@/lib/ledger-ui";
import type { LedgerDay } from "@/lib/ledger";

const sampleDay: LedgerDay = {
  day: "2026-06-28",
  index: 1,
  label: "Jun 28",
  dayOfMonth: 28,
  weekdayLabel: "Sun",
  monthKey: "2026-06",
  monthLabel: "Jun",
  inRange: true,
  state: "today",
  reachouts: 36,
  hours: 10.5,
  featureDone: true,
  replies: 0,
  meetings: 0,
  commits: 0,
  merges: 0,
  targets: { reachouts: 250 / 7, hours: 70 / 7 },
  dailyValue: 100,
  active: true,
};

test("clampReachouts rounds and clamps to the accepted API range", () => {
  expect(clampReachouts(12.4)).toBe(12);
  expect(clampReachouts(-3)).toBe(0);
  expect(clampReachouts(2048)).toBe(1000);
  expect(clampReachouts(Number.NaN)).toBe(0);
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
    "Sun Jun 28: 100 activity points, 36 reachouts, 10.5 hours",
  );
  expect(ledgerDayAriaLabel({ ...sampleDay, state: "future" })).toBe(
    "Sun Jun 28, future day",
  );
  expect(ledgerDayAriaLabel({ ...sampleDay, featureDone: false })).toBe(ledgerDayAriaLabel(sampleDay));
});
