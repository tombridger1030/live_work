import { unstable_cache } from "next/cache";
import { CAPTURES_TAG } from "@/lib/cache";
import { assembleLedger, dayRange, hoursFromPresent, LEDGER_WEEKS } from "@/lib/ledger";
import type { LedgerData } from "@/lib/ledger";
import { refreshCortalActivitySoon } from "@/lib/github-activity";
import { daysWithData, getLedgerEntries, getWeeklyGoals, snapshotCountsByDay } from "@/lib/store";
import { localDayKey, weekStartForDay } from "@/lib/time";


function addDays(dayKey: string, count: number): string {
  const at = new Date(`${dayKey}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}

const cachedLedgerData = unstable_cache(loadLedgerData, ["ledger-data"], {
  tags: [CAPTURES_TAG],
  revalidate: 300,
});

/**
 * Loads the ledger as a recent, Monday-aligned, week-grouped history. The board
 * shows at most `LEDGER_WEEKS` weeks ending with the current week — never a year
 * of empty cells. `rangeStart` marks the first real day (first data point, or the
 * window start when data is older than the cap); days outside [rangeStart, today]
 * are alignment padding the grid renders blank. The assembled board is cached
 * until the canonical capture/ledger mutation signal invalidates it (with a
 * five-minute safety TTL); today's external GitHub activity refreshes in the
 * background and never delays this read. Server-only.
 */
export async function getLedgerData(now = new Date()): Promise<LedgerData> {
  const today = localDayKey(now);
  refreshCortalActivitySoon(today);
  return cachedLedgerData(today);
}

async function loadLedgerData(today: string): Promise<LedgerData> {
  const tallyDays = await daysWithData();
  // daysWithData returns newest-first, so the oldest is the last element.
  const firstTallyDay = tallyDays.length > 0 ? tallyDays[tallyDays.length - 1] : today;
  const firstDay = firstTallyDay > today ? today : firstTallyDay;

  const currentMonday = weekStartForDay(today);
  const cappedStart = addDays(currentMonday, -(LEDGER_WEEKS - 1) * 7);
  const firstMonday = weekStartForDay(firstDay);
  // Start at the later of the cap and the first data week, so short histories show
  // from day one and long ones stay capped to the recent quarter.
  const startMonday = cappedStart > firstMonday ? cappedStart : firstMonday;
  const endSunday = addDays(currentMonday, 6);
  const rangeStart = firstDay > startMonday ? firstDay : startMonday;

  const allDays = dayRange(startMonday, endSunday);

  const [entriesList, counts, weeklyGoals] = await Promise.all([
    getLedgerEntries(rangeStart, today),
    snapshotCountsByDay(LEDGER_WEEKS * 7 + 14),
    getWeeklyGoals()
  ]);
  const entries = new Map(entriesList.map((entry) => [entry.day, entry]));
  const hoursByDay = new Map(counts.map((count) => [count.day, hoursFromPresent(count.present)]));
  return assembleLedger(allDays, entries, hoursByDay, today, rangeStart, weeklyGoals);
}
