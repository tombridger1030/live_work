import { unstable_cache } from "next/cache";
import { CAPTURES_TAG } from "@/lib/cache";
import { applyDashboardOverrides, readDashboardOverrides } from "@/lib/dashboard-overrides";
import {
  HOURS_PACE_HISTORY_DAYS,
  learnHoursPace,
  localClockMinutes,
  type HoursPaceContext,
  type HoursReferenceDay,
} from "@/lib/hours-pace";
import type { LedgerData, LedgerDay } from "@/lib/ledger";
import { isMirrorHost } from "@/lib/mirror";
import { archiveIO, archivePath } from "@/lib/mirror-archive";
import { snapshotsForDay } from "@/lib/store";
import { appTimeZone, captureIntervalMinutes, isScoringHour, localDayKey } from "@/lib/time";
import type { DashboardData } from "@/lib/dashboard";

type DeskFrame = { id: string; capturedAt: string; present: boolean };
type DayCaptures = { day: string; minutes: number[] };

/**
 * Extracts unique present captures belonging to the requested local scoring
 * day. No image, note, or private asset address leaves this server boundary.
 */
export function deskMinutesForDay(day: string, frames: DeskFrame[], timeZone: string): number[] {
  const unique = new Map(frames.map((frame) => [frame.id, frame]));
  return [...unique.values()].flatMap((frame) => {
    const at = new Date(frame.capturedAt);
    if (!frame.present || !Number.isFinite(at.getTime()) || localDayKey(at, timeZone) !== day) return [];
    const minute = localClockMinutes(at, timeZone);
    return isScoringHour(Math.floor(minute / 60)) ? [minute] : [];
  });
}

async function loadCaptures(days: string[], timeZone: string, mirror: boolean): Promise<DayCaptures[]> {
  const overrides = mirror ? await readDashboardOverrides() : null;
  return Promise.all(days.map(async (day) => {
    if (!mirror) return { day, minutes: deskMinutesForDay(day, await snapshotsForDay(day), timeZone) };
    const response = await archiveIO.read(archivePath(day));
    if (!response) return { day, minutes: [] };
    const snapshot = await response.json() as { data?: DashboardData };
    if (snapshot.data?.viewDay !== day) return { day, minutes: [] };
    const data = applyDashboardOverrides(snapshot.data, overrides!);
    return { day, minutes: deskMinutesForDay(day, Object.values(data.hourlyFrames).flat(), timeZone) };
  }));
}

const cachedCaptures = unstable_cache(loadCaptures, ["hours-pace-captures-v1"], {
  tags: [CAPTURES_TAG], revalidate: 300,
});

/**
 * Learns live pace after cached prior-day facts are read. Retained publications
 * must match the latest ledger's rounded desk total; a midday/stale archive
 * cannot stand in for a complete day. Storage failure yields explicit learning
 * rather than inventing a schedule or preventing the ledger from rendering.
 */
export async function readHoursPace(data: LedgerData, now = new Date()): Promise<HoursPaceContext> {
  const timeZone = appTimeZone();
  const today = localDayKey(now, timeZone);
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - HOURS_PACE_HISTORY_DAYS);
  const oldest = cutoff.toISOString().slice(0, 10);
  const days = data.days.filter((day) => day.inRange && day.targets !== null &&
    day.day < today && day.day >= oldest && day.hours > 0);
  try {
    const captures = await cachedCaptures(days.map((day) => day.day), timeZone, isMirrorHost());
    const facts = new Map(days.map((day) => [day.day, day]));
    return learnHoursPace(completeReferences(captures, facts), now, timeZone);
  } catch {
    console.warn("[work-live] Hours pace history unavailable");
    return learnHoursPace([], now, timeZone);
  }
}

/** Rejects archived timing that disagrees with the ledger's authoritative desk total. */
export function completeReferences(
  captures: DayCaptures[],
  facts: Map<string, Pick<LedgerDay, "hours" | "targets">>,
): HoursReferenceDay[] {
  return captures.flatMap((entry) => {
    const fact = facts.get(entry.day);
    const hours = Math.round(entry.minutes.length * captureIntervalMinutes / 60 * 10) / 10;
    return fact?.targets && Math.abs(hours - fact.hours) < 0.01
      ? [{ ...entry, target: fact.targets.hours }] : [];
  });
}
