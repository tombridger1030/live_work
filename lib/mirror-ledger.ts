import {
  assembleLedger,
  dayRange,
  LEDGER_WEEKS,
  ledgerEntryFromDay,
  WEEKLY_HOURS_TARGET,
  WEEKLY_REACHOUT_TARGET,
  type LedgerData,
  type WeeklyTargets,
} from "@/lib/ledger";
import { isValidDayKey, weekStartForDay } from "@/lib/time";
import type { WeeklyGoal } from "@/lib/types";
import { storedWeeklyGoal } from "@/lib/weekly-goal";

// A week as some Mac version published it. The Mac and the deployment update
// independently, so a snapshot may predate the per-channel goal shape.
type PublishedWeek = {
  weekStart: string;
  goal?: WeeklyTargets;
  reachoutsTarget?: number;
  hoursTarget?: number;
};

function publishedGoals(weeks: PublishedWeek[]): WeeklyGoal[] {
  return weeks.map((week) =>
    week.goal
      ? storedWeeklyGoal(week.weekStart, week.goal.outreach, week.goal.hours)
      : {
          weekStart: week.weekStart,
          reachouts: week.reachoutsTarget ?? WEEKLY_REACHOUT_TARGET,
          hours: week.hoursTarget ?? WEEKLY_HOURS_TARGET,
        },
  );
}

/**
 * Extends the last published Ledger through actual today before applying owner
 * overrides. New days have zero capture activity, never fabricated camera data.
 * Preserves source entries/goals and rebuilds all derived values within 13 weeks.
 *
 * This is the boundary for snapshots published by any Mac version: counts a
 * snapshot lacks read as 0 and legacy week targets become legacy goals, so the
 * result always has the current shape.
 */
export function mirrorLedgerForToday(
  data: LedgerData,
  today: string,
): LedgerData {
  if (!isValidDayKey(today)) throw new Error("Invalid Ledger day");
  const monday = weekStartForDay(today);
  const shift = (day: string, days: number): string => {
    const at = new Date(`${day}T12:00:00Z`);
    at.setUTCDate(at.getUTCDate() + days);
    return at.toISOString().slice(0, 10);
  };
  const cutoff = shift(monday, -(LEDGER_WEEKS - 1) * 7);
  const start = data.startDay > cutoff ? data.startDay : cutoff;
  const rangeStart = data.days.find((day) => day.inRange)?.day ?? today;
  const entries = new Map(
    data.days
      .filter((day) => day.inRange)
      .map((day) => [day.day, ledgerEntryFromDay(day)]),
  );
  return assembleLedger(
    dayRange(start, shift(monday, 6)),
    entries,
    new Map(data.days.map((day) => [day.day, day.hours])),
    today,
    rangeStart,
    publishedGoals(data.weeks as PublishedWeek[]),
  );
}
