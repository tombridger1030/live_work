import { expect, test } from "bun:test";
import {
  catchUpBar,
  dailyOutreachBar,
  isOutreachDay,
  outreachProgress,
  weekdaysLeft,
} from "@/lib/outreach-pace";
import { dayRange } from "@/lib/ledger";

// Week of Mon 2026-10-05 .. Sun 2026-10-11.
const WEEK = dayRange("2026-10-05", "2026-10-11");

test("outreach runs Monday to Friday only", () => {
  expect(WEEK.map(isOutreachDay)).toEqual([
    true,
    true,
    true,
    true,
    true,
    false,
    false,
  ]);
  expect(WEEK.map(weekdaysLeft)).toEqual([5, 4, 3, 2, 1, 0, 0]);
});

test("the reported Thursday: 150 goal, 42 sent before today, asks for 54", () => {
  expect(catchUpBar(150, 42, "2026-10-08")).toBe(54);
});

test("the bar splits what is left over the weekdays left, rounded up", () => {
  expect(catchUpBar(150, 0, "2026-10-05")).toBe(30); // Monday: 150 / 5
  expect(catchUpBar(150, 41, "2026-10-08")).toBe(55); // 109 / 2 = 54.5, shown as the number that clears it
  expect(catchUpBar(150, 0, "2026-10-09")).toBe(150); // Friday, nothing sent: no cap
});

test("ahead of pace asks for nothing, weekends ask for nothing at all", () => {
  expect(catchUpBar(150, 160, "2026-10-08")).toBe(0);
  expect(catchUpBar(150, 0, "2026-10-10")).toBeNull();
  expect(catchUpBar(150, 0, "2026-10-11")).toBeNull();
});

test("hitting every bar exactly reaches the weekly goal by Friday", () => {
  for (const goal of [1, 7, 99, 100, 150, 151, 999]) {
    let logged = 0;
    for (const day of WEEK) {
      const bar = catchUpBar(goal, logged, day);
      if (bar !== null) logged += bar;
    }
    expect(logged).toBeGreaterThanOrEqual(goal);
    expect(logged).toBeLessThan(goal + 5);
  }
});

test("invalid inputs crash instead of producing a bar", () => {
  expect(() => catchUpBar(-1, 0, "2026-10-05")).toThrow();
  expect(() => catchUpBar(150, Number.NaN, "2026-10-05")).toThrow();
  expect(() => catchUpBar(150, 0, "2026-13-05")).toThrow();
});

test("a channel goal paces each channel on its own", () => {
  const goal = {
    kind: "channels",
    emails: 100,
    connectionRequests: 50,
  } as const;
  expect(
    dailyOutreachBar(
      goal,
      { touches: 0, emails: 40, connectionRequests: 0 },
      "2026-10-08",
    ),
  ).toEqual({
    kind: "channels",
    emails: 30,
    connectionRequests: 25,
  });
  expect(
    dailyOutreachBar(
      goal,
      { touches: 0, emails: 0, connectionRequests: 0 },
      "2026-10-10",
    ),
  ).toBeNull();
  expect(
    dailyOutreachBar(
      { kind: "touches", touches: 150 },
      { touches: 42, emails: 0, connectionRequests: 0 },
      "2026-10-08",
    ),
  ).toEqual({ kind: "touches", touches: 54 });
});

test("progress caps each channel so one cannot cover for the other", () => {
  const bar = { kind: "channels", emails: 20, connectionRequests: 10 } as const;
  expect(
    outreachProgress({ touches: 30, emails: 30, connectionRequests: 0 }, bar),
  ).toBeCloseTo(20 / 30, 10);
  expect(
    outreachProgress({ touches: 30, emails: 20, connectionRequests: 10 }, bar),
  ).toBe(1);
  expect(
    outreachProgress(
      { touches: 12, emails: 0, connectionRequests: 0 },
      { kind: "touches", touches: 54 },
    ),
  ).toBeCloseTo(12 / 54, 10);
  // A bar of zero means you are ahead of pace: met.
  expect(
    outreachProgress(
      { touches: 0, emails: 0, connectionRequests: 0 },
      { kind: "touches", touches: 0 },
    ),
  ).toBe(1);
  expect(
    outreachProgress(
      { touches: 0, emails: 0, connectionRequests: 0 },
      { kind: "channels", emails: 0, connectionRequests: 0 },
    ),
  ).toBe(1);
});
