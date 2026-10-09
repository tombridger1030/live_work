import { expect, test } from "bun:test";
import { assembleLedger, dayRange } from "@/lib/ledger";
import { MANUAL_COUNT_FIELDS } from "@/lib/ledger-fields";
import type { LedgerEntry } from "@/lib/types";

test("a week sums every manual count over its elapsed days only", () => {
  // 2026-06-22 is a Monday; today is Wednesday, so Thursday's entry is not yet real.
  const days = dayRange("2026-06-22", "2026-06-28");
  const entries = new Map<string, LedgerEntry>([
    [
      days[0],
      {
        day: days[0],
        featureDone: false,
        commits: 0,
        merges: 0,
        reachouts: 40,
        emailsSent: 10,
        linkedinReplies: 2,
      },
    ],
    [
      days[2],
      {
        day: days[2],
        featureDone: false,
        commits: 0,
        merges: 0,
        reachouts: 60,
        connectionRequests: 5,
        replies: 3,
      },
    ],
    [
      days[3],
      {
        day: days[3],
        featureDone: false,
        commits: 0,
        merges: 0,
        reachouts: 999,
      },
    ],
  ]);
  const week = assembleLedger(days, entries, new Map(), days[2], days[0])
    .weeks[0];

  expect(week.counts.reachouts).toBe(100);
  expect(week.counts.emailsSent).toBe(10);
  expect(week.counts.connectionRequests).toBe(5);
  expect(week.counts.replies).toBe(3);
  expect(week.counts.linkedinReplies).toBe(2);
  expect(Object.keys(week.counts).sort()).toEqual(
    [...MANUAL_COUNT_FIELDS].sort(),
  );
  // New-prospect touches: unsplit touches + emails + requests. Replies never count.
  expect(week.touches).toBe(115);
});

test("a stored row missing newer counts reads them as zero", () => {
  const days = dayRange("2026-06-22", "2026-06-28");
  const legacyRow = {
    day: days[0],
    featureDone: false,
    commits: 0,
    merges: 0,
    reachouts: 12,
    replies: 1,
    meetings: 0,
  };
  const data = assembleLedger(
    days,
    new Map([[days[0], legacyRow]]),
    new Map(),
    days[0],
    days[0],
  );
  expect(data.days[0].emailsSent).toBe(0);
  expect(data.days[0].linkedinMessages).toBe(0);
  expect(data.days[0].reachouts).toBe(12);
  expect(Number.isNaN(data.days[0].dailyValue)).toBe(false);
});
