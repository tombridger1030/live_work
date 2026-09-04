import { assembleLedger, dayRange, LEDGER_WEEKS, type LedgerData } from "@/lib/ledger";
import { isValidDayKey, weekStartForDay } from "@/lib/time";

/**
 * Extends the last published Ledger through actual today before applying owner
 * overrides. New days have zero capture activity, never fabricated camera data.
 * Preserves source entries/goals and rebuilds all derived values within 13 weeks.
 */
export function mirrorLedgerForToday(data: LedgerData, today: string): LedgerData {
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
  const entries = new Map(data.days.filter((day) => day.inRange).map((day) => [day.day, {
    day: day.day, reachouts: day.reachouts, featureDone: day.featureDone,
    replies: day.replies, meetings: day.meetings, commits: day.commits, merges: day.merges,
  }]));
  return assembleLedger(dayRange(start, shift(monday, 6)), entries,
    new Map(data.days.map((day) => [day.day, day.hours])), today, rangeStart,
    data.weeks.map((week) => ({ weekStart: week.weekStart, reachouts: week.reachoutsTarget, hours: week.hoursTarget })));
}
