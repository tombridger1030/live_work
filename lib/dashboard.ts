import { unstable_cache } from "next/cache";
import { dailyHistory, daysWithData, getSettings, hourlyForDay, latestSnapshot, recentScoringHours, snapshotCountsByDay, snapshotsForDay } from "@/lib/store";
import { appTimeZone, captureIntervalMinutes, isScoringHour, localDayKey, localHour } from "@/lib/time";
import { publicStatusFor, type PublicStatusState } from "@/lib/status";
import type { AverageStats, AverageWindow, DayHistory, HourlyCheckin, Settings, SnapshotRow, TodayStats } from "@/lib/types";


// Cache the slow, mostly historical reads (a year-wide aggregate, old per-day
// rows, day lists) in the Next Data Cache, tagged so a new capture busts them
// via revalidateTag("captures"). Today is the live surface: its snapshots and
// hourly rows are read uncached so router.refresh() cannot render a stale frame
// while the user is watching the dashboard.
const cacheOptions = { tags: ["captures"], revalidate: 300 }; // tag-busted on capture; 5-min TTL as a safety net
const cachedDailyHistory = unstable_cache(dailyHistory, ["daily-history"], cacheOptions);
const cachedSnapshotsForDay = unstable_cache(snapshotsForDay, ["snapshots-for-day"], cacheOptions);
const cachedHourlyForDay = unstable_cache(hourlyForDay, ["hourly-for-day"], cacheOptions);
const cachedDaysWithData = unstable_cache(daysWithData, ["days-with-data"], cacheOptions);
const cachedRecentScoringHours = unstable_cache(recentScoringHours, ["recent-scoring-hours"], cacheOptions);
const cachedSnapshotCountsByDay = unstable_cache(snapshotCountsByDay, ["snapshot-counts-by-day"], cacheOptions);

export type DashboardData = {
  viewDay: string; // local day being shown (YYYY-MM-DD)
  viewDayLabel: string; // human label for viewDay, e.g. "Mon, Jun 15"
  timeZone: string; // app display timezone; format frame clock times in it so they match the hour buckets
  today: string; // local today
  isToday: boolean;
  prevDay: string | null; // nearest earlier day with data, else null
  nextDay: string | null; // nearest later day with data (never the future), else null
  latest: SnapshotRow | null; // live latest snapshot; drives the live status today
  statusState: PublicStatusState; // live status; only meaningful when isToday
  hourly: HourlyCheckin[]; // viewDay's per-hour aggregates
  hourlyFrames: Record<number, SnapshotRow[]>; // viewDay's snapshots grouped by local hour, ascending
  defaultHour: number | null; // hour the hero selects by default for viewDay
  settings: Settings;
  stats: TodayStats; // viewDay's stats
  previousStats: TodayStats | null; // Today baseline: prior day at same local time; historical baseline: full prior day
  history: DayHistory[]; // recent per-day focus aggregates for the heatmap, newest first
  averages: AverageStats; // rolling 7/30-day averages over recent present days
};

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_DAYS = 371; // ~53 weeks (a full year) of daily focus history for the heatmap
const AVERAGE_WINDOW_DAYS = 30; // widest rolling window pulled; the 7-day view is a leading slice of it

/**
 * Groups a day's snapshots by local hour, preserving ascending capture order
 * within each hour. The hourly bar shows only the average; this keeps every
 * frame so the hour-detail filmstrip can show each snapshot and its own score.
 * Input must already be sorted ascending by `capturedAt`.
 */
export function framesByHour(snapshots: SnapshotRow[]): Record<number, SnapshotRow[]> {
  const byHour: Record<number, SnapshotRow[]> = {};
  for (const snapshot of snapshots) {
    const hour = localHour(new Date(snapshot.capturedAt));
    (byHour[hour] ??= []).push(snapshot);
  }
  return byHour;
}

/**
 * True when `viewDay` is the live local day. Live-day snapshot and hourly reads
 * must bypass Next's data cache so a client `router.refresh()` can show newly
 * captured frames immediately; historical days may use the cached readers.
 */
export function shouldReadViewDayUncached(viewDay: string, today: string): boolean {
  return viewDay === today;
}

function criticalHourCount(hourly: HourlyCheckin[]): number {
  return hourly.filter((checkin) => isScoringHour(checkin.hour) && checkin.critical).length;
}

export function dayStats(snapshots: SnapshotRow[], hourly: HourlyCheckin[]): TodayStats {
  // Only the 8am–11pm scoring window counts toward the day; hours outside it
  // (overnight, late night) are shown elsewhere but never scored.
  const scoped = snapshots.filter((snapshot) => isScoringHour(localHour(new Date(snapshot.capturedAt))));
  const presentSnapshots = scoped.filter((snapshot) => snapshot.present);
  const headphonesPct =
    scoped.length === 0 ? 0 : Math.round((scoped.filter((snapshot) => snapshot.headphones).length / scoped.length) * 100);
  const scoringHours = hourly.filter((checkin) => isScoringHour(checkin.hour));
  const avgScore =
    scoringHours.length === 0
      ? 0
      : Math.round(scoringHours.reduce((total, checkin) => total + checkin.avgScore, 0) / scoringHours.length);

  return {
    snapshots: scoped.length,
    avgScore,
    // Each present snapshot stands for one capture interval of elapsed time.
    hoursPresent: Math.round(((presentSnapshots.length * captureIntervalMinutes) / 60) * 10) / 10,
    headphonesPct,
    criticalHours: criticalHourCount(hourly)
  };
}

function localMinuteOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: appTimeZone(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!hour || !minute) {
    throw new Error("Unable to format local minute of day");
  }
  return (hour === "24" ? 0 : Number(hour)) * 60 + Number(minute);
}

/**
 * Same shape as `dayStats`, but capped at the cutoff's local time of day.
 * Snapshot-backed metrics include frames captured up through that minute; hourly
 * metrics include only fully elapsed hourly rollups, matching what today's live
 * dashboard has available before the current hour is rolled up.
 */
export function statsUpToLocalTime(snapshots: SnapshotRow[], hourly: HourlyCheckin[], cutoff: Date): TodayStats {
  const cutoffMinute = localMinuteOfDay(cutoff);
  const snapshotsThroughCutoff = snapshots.filter((snapshot) => localMinuteOfDay(new Date(snapshot.capturedAt)) <= cutoffMinute);
  const hourlyThroughCutoff = hourly.filter((checkin) => (checkin.hour + 1) * 60 <= cutoffMinute);
  return dayStats(snapshotsThroughCutoff, hourlyThroughCutoff);
}

type DayFocus = {
  day: string;
  avgScore: number;
  hoursPresent: number;
  headphonesPct: number;
  criticalHours: number;
  snapshots: number;
};

/**
 * Collapses scoring-window hourly rows + per-day snapshot counts into one metric
 * row per present day (descending). `snapshotsByDay` maps local day → its total
 * and present scoring-window snapshot counts (present drives hours-present).
 */
export function dailyFocusMetrics(
  hourly: HourlyCheckin[],
  snapshotsByDay: Map<string, { snapshots: number; present: number }>
): DayFocus[] {
  const byDay = new Map<string, HourlyCheckin[]>();
  for (const checkin of hourly) {
    const bucket = byDay.get(checkin.day);
    if (bucket) {
      bucket.push(checkin);
    } else {
      byDay.set(checkin.day, [checkin]);
    }
  }
  return Array.from(byDay.entries())
    .map(([day, hours]) => {
      const counts = snapshotsByDay.get(day);
      return {
        day,
        avgScore: Math.round(hours.reduce((total, checkin) => total + checkin.avgScore, 0) / hours.length),
        hoursPresent: Math.round((((counts?.present ?? 0) * captureIntervalMinutes) / 60) * 10) / 10,
        headphonesPct: Math.round(hours.reduce((total, checkin) => total + checkin.headphonesPct, 0) / hours.length),
        criticalHours: hours.filter((checkin) => checkin.critical).length,
        snapshots: counts?.snapshots ?? 0
      };
    })
    .sort((left, right) => right.day.localeCompare(left.day));
}

function averageWindow(daysDescending: DayFocus[], windowSize: number): AverageWindow {
  const slice = daysDescending.slice(0, windowSize);
  if (slice.length === 0) {
    return { days: 0, avgScore: 0, hoursPresent: 0, headphonesPct: 0, criticalHours: 0, snapshots: 0 };
  }
  const total = slice.reduce(
    (acc, day) => ({
      avgScore: acc.avgScore + day.avgScore,
      hoursPresent: acc.hoursPresent + day.hoursPresent,
      headphonesPct: acc.headphonesPct + day.headphonesPct,
      criticalHours: acc.criticalHours + day.criticalHours,
      snapshots: acc.snapshots + day.snapshots
    }),
    { avgScore: 0, hoursPresent: 0, headphonesPct: 0, criticalHours: 0, snapshots: 0 }
  );
  return {
    days: slice.length,
    avgScore: Math.round(total.avgScore / slice.length),
    hoursPresent: Math.round((total.hoursPresent / slice.length) * 10) / 10,
    headphonesPct: Math.round(total.headphonesPct / slice.length),
    criticalHours: Math.round((total.criticalHours / slice.length) * 10) / 10,
    snapshots: Math.round(total.snapshots / slice.length)
  };
}

/**
 * Rolling 7- and 30-day averages over the most recent present days only, so days
 * without captures never dilute the result. The 7-day window is the leading
 * slice of the same descending day list.
 */
export function buildAverageStats(daily: DayFocus[]): AverageStats {
  return { last7: averageWindow(daily, 7), last30: averageWindow(daily, 30) };
}

function statsFromDayFocus(day: DayFocus): TodayStats {
  return {
    snapshots: day.snapshots,
    avgScore: day.avgScore,
    hoursPresent: day.hoursPresent,
    headphonesPct: day.headphonesPct,
    criticalHours: day.criticalHours
  };
}

function previousDayFocus(daily: DayFocus[], viewDay: string): DayFocus | null {
  const index = daily.findIndex((entry) => entry.day === viewDay);
  return index >= 0 ? (daily[index + 1] ?? null) : (daily.find((entry) => entry.day < viewDay) ?? null);
}

/**
 * Metrics of the present day immediately before `viewDay`. Historical days use
 * that prior day's full metrics. Today's live dashboard uses the same prior day
 * only up to the current local time; see `previousStatsForViewDay`.
 */
export function previousDayStats(daily: DayFocus[], viewDay: string): TodayStats | null {
  const prior = previousDayFocus(daily, viewDay);
  return prior ? statsFromDayFocus(prior) : null;
}

async function previousStatsForViewDay(
  daily: DayFocus[],
  viewDay: string,
  isToday: boolean,
  now: Date,
  recentHours: HourlyCheckin[]
): Promise<TodayStats | null> {
  const prior = previousDayFocus(daily, viewDay);
  if (!prior) {
    return null;
  }
  if (!isToday) {
    return statsFromDayFocus(prior);
  }
  const priorSnapshots = await cachedSnapshotsForDay(prior.day);
  const priorHourly = recentHours.filter((checkin) => checkin.day === prior.day);
  return statsUpToLocalTime(priorSnapshots, priorHourly, now);
}

export async function getDashboardData(now = new Date(), requestedDay?: string): Promise<DashboardData> {
  const today = localDayKey(now);
  const viewDay = requestedDay && dayPattern.test(requestedDay) && requestedDay <= today ? requestedDay : today;
  const isToday = viewDay === today;

  const readHourlyForViewDay = shouldReadViewDayUncached(viewDay, today) ? hourlyForDay : cachedHourlyForDay;
  const readSnapshotsForViewDay = shouldReadViewDayUncached(viewDay, today) ? snapshotsForDay : cachedSnapshotsForDay;

  const [latest, hourly, settings, daySnapshots, days, history, recentHours, snapshotCounts] = await Promise.all([
    latestSnapshot(),
    readHourlyForViewDay(viewDay),
    getSettings(),
    readSnapshotsForViewDay(viewDay),
    cachedDaysWithData(),
    cachedDailyHistory(HISTORY_DAYS),
    cachedRecentScoringHours(AVERAGE_WINDOW_DAYS),
    cachedSnapshotCountsByDay(AVERAGE_WINDOW_DAYS)
  ]);

  // Every snapshot grouped by its local hour; the hero shows the latest, the
  // hour-detail filmstrip shows them all.
  const hourlyFrames = framesByHour(daySnapshots);

  // Rolling averages are window-anchored to real today, independent of viewDay.
  const snapshotsByDay = new Map(
    snapshotCounts.map((entry) => [entry.day, { snapshots: entry.snapshots, present: entry.present }])
  );
  const daily = dailyFocusMetrics(recentHours, snapshotsByDay);
  const averages = buildAverageStats(daily);
  const previousStats = await previousStatsForViewDay(daily, viewDay, isToday, now, recentHours);

  const dayLast = daySnapshots.at(-1) ?? null;
  const defaultHour = isToday
    ? latest
      ? localHour(new Date(latest.capturedAt))
      : null
    : dayLast
      ? localHour(new Date(dayLast.capturedAt))
      : null;

  // Navigate only across days that actually have data; never into the future.
  const prevDay = days.find((candidate) => candidate < viewDay) ?? null;
  const laterDays = days.filter((candidate) => candidate > viewDay && candidate <= today);
  const nextDay = laterDays.length > 0 ? laterDays[laterDays.length - 1] : null;

  return {
    viewDay,
    viewDayLabel: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric"
    }).format(new Date(`${viewDay}T12:00:00Z`)),
    today,
    isToday,
    prevDay,
    nextDay,
    timeZone: appTimeZone(),
    latest,
    statusState: publicStatusFor(latest, settings, now),
    hourly,
    hourlyFrames,
    defaultHour,
    settings,
    stats: dayStats(daySnapshots, hourly),
    averages,
    previousStats,
    history
  };
}
