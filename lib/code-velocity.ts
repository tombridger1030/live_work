import { z } from "zod";

export const CODE_WINDOW_DAYS = 35;
export const CODE_STALE_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const instant = z.string().datetime({ offset: true });

export const codeSnapshotSchema = z.object({
  from: instant,
  through: instant,
  commits: z.array(z.object({ id: z.string().min(1), at: instant })),
  merges: z.array(z.object({ id: z.string().min(1), at: instant })),
  lastCommitAt: instant.nullable(),
}).superRefine((snapshot, context) => {
  const from = Date.parse(snapshot.from);
  const through = Date.parse(snapshot.through);
  if (from >= through || [...snapshot.commits, ...snapshot.merges].some(
    (event) => Date.parse(event.at) < from || Date.parse(event.at) >= through,
  ) || (snapshot.lastCommitAt && Date.parse(snapshot.lastCommitAt) >= through)) {
    context.addIssue({ code: "custom", message: "Invalid code coverage window" });
  }
});

export type CodeSnapshot = z.infer<typeof codeSnapshotSchema>;
export type CodePulseData = {
  status: "ready" | "building-baseline" | "unavailable";
  freshness: "fresh" | "stale" | "unavailable";
  commits: number | null;
  merges: number | null;
  lastCommitAt: string | null;
  score: number | null;
  baselineWeeklyPace: number | null;
  asOf: string | null;
  day?: { date: string; commits: number; merges: number; lastCommitAt: string | null } | null;
  week?: CodeWeekActivity | null;
};

/** A verified Monday-to-selected-day total and the matching elapsed portion of
 * the prior week. A null comparison means the retained observation history is
 * not complete enough to call a change an improvement.
 */
export type CodeWeekActivity = {
  weekStart: string;
  through: string;
  commits: number;
  merges: number;
  comparison: { commits: number; merges: number } | null;
};

/**
 * Summarizes a verified snapshot at its observation time (not the browser clock).
 * Each distinct landed SHA and authored merged PR contributes one pace unit.
 * Last seven elapsed days / (preceding 28 days / 4) * 100, rounded and capped.
 * Incomplete 35-day coverage or a zero baseline yields no score; absent data
 * yields null counts. A failed/stale refresh keeps the exact last known window.
 * `now` is epoch milliseconds and is used only for freshness, never scoring.
 */
export function codeVelocity(
  snapshot: CodeSnapshot | null,
  now = Date.now(),
  failed = false,
): CodePulseData {
  if (!Number.isFinite(now)) throw new Error("Invalid observation clock");
  if (!snapshot) return {
    status: "unavailable", freshness: "unavailable", commits: null, merges: null,
    lastCommitAt: null, score: null, baselineWeeklyPace: null, asOf: null,
  };
  const data = codeSnapshotSchema.parse(snapshot);
  const end = Date.parse(data.through);
  const split = end - 7 * DAY_MS;
  const start = end - CODE_WINDOW_DAYS * DAY_MS;
  const unique = (events: CodeSnapshot["commits"]) => [...new Map(events.map((event) => [event.id, event])).values()];
  const commits = unique(data.commits);
  const merges = unique(data.merges);
  const recent = (events: typeof commits) => events.filter((event) => Date.parse(event.at) >= split).length;
  const baseline = [...commits, ...merges].filter((event) => Date.parse(event.at) >= start && Date.parse(event.at) < split).length / 4;
  const complete = Date.parse(data.from) <= start;
  const score = complete && baseline > 0 ? Math.min(100, Math.round((recent(commits) + recent(merges)) / baseline * 100)) : null;
  return {
    status: score === null ? "building-baseline" : "ready",
    freshness: failed || now - end > CODE_STALE_MS ? "stale" : "fresh",
    commits: recent(commits), merges: recent(merges), lastCommitAt: data.lastCommitAt,
    score, baselineWeeklyPace: complete ? baseline : null, asOf: data.through,
  };
}
