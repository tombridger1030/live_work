import { expect, test } from "bun:test";
import { assembleLedger, dayRange } from "@/lib/ledger";
import type { LedgerEntry } from "@/lib/types";

test("weekly replyRate and bookingRate compute correctly with non-zero denominators", () => {
  // 2026-06-22 is a Monday, 2026-06-28 the following Sunday.
  const days = dayRange("2026-06-22", "2026-06-28");
  const entries = new Map<string, LedgerEntry>();
  // Spread reachouts=100, replies=25, meetings=5 across a few days.
  entries.set(days[0], { day: days[0], reachouts: 40, featureDone: false, replies: 10, meetings: 2, commits: 0, merges: 0 });
  entries.set(days[2], { day: days[2], reachouts: 60, featureDone: false, replies: 15, meetings: 3, commits: 0, merges: 0 });

  const hoursByDay = new Map<string, number>();
  const data = assembleLedger(days, entries, hoursByDay, "2026-07-10", "2026-06-22");

  expect(data.weeks.length).toBe(1);
  const week = data.weeks[0];

  // Verify sums.
  expect(week.replies).toBe(25);
  expect(week.meetings).toBe(5);

  // Verify rates: replyRate = 25/100 = 0.25, bookingRate = 5/25 = 0.2.
  expect(week.replyRate).toBeCloseTo(0.25, 5);
  expect(week.bookingRate).toBeCloseTo(0.2, 5);
});

test("weekly replyRate is 0 when reachouts is 0 (not NaN)", () => {
  const days = dayRange("2026-06-22", "2026-06-28");
  const entries = new Map<string, LedgerEntry>();
  // Zero reachouts, some replies (edge case: replies without reachouts).
  entries.set(days[0], { day: days[0], reachouts: 0, featureDone: false, replies: 10, meetings: 2, commits: 0, merges: 0 });

  const hoursByDay = new Map<string, number>();
  const data = assembleLedger(days, entries, hoursByDay, "2026-07-10", "2026-06-22");

  const week = data.weeks[0];

  // Guard against NaN: replyRate must be 0 when reachouts is 0.
  expect(week.replyRate).toBe(0);
  expect(Number.isNaN(week.replyRate)).toBe(false);
});

test("weekly bookingRate is 0 when replies is 0 (not NaN)", () => {
  const days = dayRange("2026-06-22", "2026-06-28");
  const entries = new Map<string, LedgerEntry>();
  // Reachouts but zero replies.
  entries.set(days[0], { day: days[0], reachouts: 50, featureDone: false, replies: 0, meetings: 0, commits: 0, merges: 0 });
  entries.set(days[1], { day: days[1], reachouts: 30, featureDone: false, replies: 0, meetings: 0, commits: 0, merges: 0 });

  const hoursByDay = new Map<string, number>();
  const data = assembleLedger(days, entries, hoursByDay, "2026-07-10", "2026-06-22");

  const week = data.weeks[0];

  // Guard against NaN: bookingRate must be 0 when replies is 0.
  expect(week.bookingRate).toBe(0);
  expect(Number.isNaN(week.bookingRate)).toBe(false);
});
