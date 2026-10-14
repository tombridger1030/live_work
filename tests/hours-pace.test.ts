import { expect, test } from "bun:test";
import { learnHoursPace, hoursPaceForGoal, type HoursReferenceDay } from "@/lib/hours-pace";
import { deskMinutesForDay, completeReferences } from "@/lib/hours-pace-server";
import { assembleLedger, dayRange, reassembleLedger } from "@/lib/ledger";

const ZONE = "America/Vancouver";
const NOON = new Date("2026-10-14T19:45:00Z");
const ticks = (start: number, hours = 8) => Array.from({ length: hours * 12 }, (_, i) => start + (i + 1) * 5);
const history = (start = 480): HoursReferenceDay[] => ["2026-10-06", "2026-10-07", "2026-10-08"]
  .map((day) => ({ day, minutes: ticks(start), target: 8 }));

test("late start remains behind a learned morning, and on-track work earns the hours share", () => {
  const context = learnHoursPace(history(), NOON, ZONE);
  const late = hoursPaceForGoal(context, 2.2, 9.8);
  expect(context.basis).toBe("successful");
  expect(late.expectedHours).toBe(4.75);
  expect(late.deltaHours).toBeCloseTo(-2.55);
  expect(late.state).toBe("behind");
  expect(Math.round(late.progress * 30)).toBe(14);
  expect(hoursPaceForGoal(context, 4.75, 9.8)).toMatchObject({ progress: 1, state: "on pace" });
  expect(hoursPaceForGoal(context, 9.8, 9.8).state).toBe("done");
});

test("history changes the curve without a fixed workday, and goals scale the expectation", () => {
  const later = learnHoursPace(history(630), NOON, ZONE);
  expect(hoursPaceForGoal(later, 2.2, 9.8).expectedHours).toBeCloseTo(2.75625);
  expect(hoursPaceForGoal(later, 2.2, 4).expectedHours).toBeCloseTo(1.125);
  expect(hoursPaceForGoal(learnHoursPace(history(), NOON, ZONE), 2.2, 9.8).expectedHours)
    .toBeGreaterThan(hoursPaceForGoal(later, 2.2, 9.8).expectedHours!);
});

test("today, future dates, weekends, and stale history cannot excuse a late start", () => {
  const expected = learnHoursPace(history(), NOON, ZONE);
  const extras = ["2026-10-14", "2026-10-15", "2026-10-10", "2026-08-12"]
    .map((day) => ({ day, minutes: ticks(850), target: 8 }));
  expect(learnHoursPace([...history(), ...extras], NOON, ZONE)).toEqual(expected);
});

test("stronger-day fallback excludes tiny goal-reaching days and exposes its basis", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  const samples = [1, 2, 3, 7, 8, 9].map((hours, i) => ({
    day: days[i], minutes: ticks(480, hours), target: i < 3 ? hours : 12,
  }));
  const context = learnHoursPace(samples, NOON, ZONE);
  expect(context.basis).toBe("stronger");
  expect(context.referenceDays).toEqual(days.slice(3));
});

test("sparse history is explicit, and day close always requires the full goal", () => {
  const learning = learnHoursPace(history().slice(0, 2), NOON, ZONE);
  expect(hoursPaceForGoal(learning, 2.2, 9.8)).toMatchObject({ expectedHours: null, state: "learning" });
  expect(hoursPaceForGoal(learning, 2.2, 9.8).progress).toBeCloseTo(2.2 / 9.8);
  const closed = learnHoursPace([], new Date("2026-10-15T06:00:00Z"), ZONE);
  expect(hoursPaceForGoal(closed, 8, 9.8).expectedHours).toBe(9.8);
});

test("before work is expected, zero hours are neutral and earn no points", () => {
  const context = learnHoursPace(history(), new Date("2026-10-14T14:00:00Z"), ZONE);
  expect(hoursPaceForGoal(context, 0, 9.8)).toMatchObject({ expectedHours: 0, progress: 0, state: "not due yet" });
  expect(() => hoursPaceForGoal(context, -1, 9.8)).toThrow();
  expect(() => learnHoursPace([], new Date("invalid"), ZONE)).toThrow();
});

test("local dates and wall-clock pace survive midnight and DST", () => {
  expect(learnHoursPace(history(), new Date("2026-10-15T00:30:00Z"), ZONE).day).toBe("2026-10-14");
  expect(learnHoursPace([], new Date("2026-10-14T16:45:00Z"), "America/New_York").elapsedHours).toBe(4.75);
  expect(learnHoursPace([], new Date("2026-11-02T17:45:00Z"), "America/New_York").elapsedHours).toBe(4.75);
});

test("capture extraction deduplicates 1000 frames and excludes other days and quiet hours", () => {
  const frames = Array.from({ length: 1000 }, (_, i) => ({ id: String(i % 10), present: true, capturedAt: "2026-10-13T19:45:00Z" }));
  frames.push({ id: "quiet", present: true, capturedAt: "2026-10-13T10:00:00Z" });
  frames.push({ id: "other-day", present: true, capturedAt: "2026-10-14T19:45:00Z" });
  frames.push({ id: "absent", present: false, capturedAt: "2026-10-13T19:45:00Z" });
  expect(deskMinutesForDay("2026-10-13", frames, ZONE)).toEqual(Array(10).fill(765));
  const facts = new Map([["2026-10-13", { hours: 8, targets: { outreach: { kind: "touches" as const, touches: 50 }, hours: 8 } }]]);
  expect(completeReferences([{ day: "2026-10-13", minutes: ticks(480, 3) }], facts)).toEqual([]);
  expect(completeReferences([{ day: "2026-10-13", minutes: ticks(480, 8) }], facts)).toHaveLength(1);
});

test("the ledger and optimistic away edits keep live pace, while past and weekly scores stay final", () => {
  const data = assembleLedger(dayRange("2026-10-12", "2026-10-18"), new Map(),
    new Map([["2026-10-13", 6.3], ["2026-10-14", 2.2]]), "2026-10-14", "2026-10-12",
    [{ weekStart: "2026-10-12", reachouts: 250, hours: 55 }]);
  const context = learnHoursPace(history(), NOON, ZONE);
  const paced = reassembleLedger(data, {}, undefined, context);
  const today = paced.days.find((day) => day.day === data.today)!;
  expect(today.targets?.hours).toBe(9.8);
  expect(today.scoreParts?.hours).toBe(14);
  expect(today.hoursPace?.state).toBe("behind");
  expect(paced.days[1]).toEqual(data.days[1]);
  expect(paced.weeks[0].scoreParts).toEqual(data.weeks[0].scoreParts);
  expect(paced.dailyChart.at(-1)?.scoreParts).toEqual(today.scoreParts!);
  const edited = reassembleLedger(paced, { "2026-10-14": { awayMinutes: 120 } });
  expect(edited.hoursPaceContext).toEqual(context);
  expect(edited.days[2].creditedHours).toBe(3.2);
  expect(edited.days[2].hoursPace?.expectedHours).toBe(today.hoursPace?.expectedHours);
  expect(edited.days[2].scoreParts?.hours).toBe(20);
  expect(() => reassembleLedger(data, {}, undefined, { ...context, day: "2026-10-13" })).toThrow();
});
