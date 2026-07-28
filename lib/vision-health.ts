import type { SnapshotRow } from "@/lib/types";
import { VISION_CREDITS_NOTE, VISION_UNAVAILABLE_NOTE } from "@/lib/vision";

/**
 * Whether the vision model is actually reading frames right now.
 *
 * `"credits"` — the AI account is out of money. This never clears on its own, so
 * it is surfaced on the first occurrence.
 * `"unavailable"` — providers are failing for some other reason. Requires a run
 * of consecutive failures, because the model list already fails over between
 * independent providers and a lone blip is not worth alarming about.
 * `"ok"` — reads are landing, or there is nothing recent to judge.
 */
export type VisionHealth = {
  status: "ok" | "credits" | "unavailable";
  failing: number; // consecutive recent frames that got no model read
  since: string | null; // ISO capture time of the oldest frame in that run
};

// A lone failure is noise once model failover is in play; three in a row (~15
// minutes at the 5-minute cadence) is a real outage.
const UNAVAILABLE_RUN = 3;
// Beyond this, the newest frame is too old to say anything about "right now" —
// the owner is simply away and no banner is warranted.
const FRESH_WINDOW_MS = 45 * 60_000;

const BLIND_NOTES = new Set<string>([VISION_UNAVAILABLE_NOTE, VISION_CREDITS_NOTE]);

/**
 * Classifies vision health from recent snapshots, newest-first or oldest-first.
 *
 * Only frames where a person was detected are considered, because those are the
 * only ones that ask the model anything — an empty desk producing no model reads
 * is correct behavior, not an outage.
 *
 * Pure: takes the frames the caller already loaded and adds no queries.
 */
export function visionHealthFrom(snapshots: readonly SnapshotRow[], now: Date = new Date()): VisionHealth {
  const judged = snapshots
    .filter((snapshot) => snapshot.present)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));

  const newest = judged[0];
  if (!newest || now.getTime() - new Date(newest.capturedAt).getTime() > FRESH_WINDOW_MS) {
    return { status: "ok", failing: 0, since: null };
  }

  let failing = 0;
  let credits = false;
  let since: string | null = null;
  for (const snapshot of judged) {
    if (!BLIND_NOTES.has(snapshot.note ?? "")) break;
    failing += 1;
    since = snapshot.capturedAt;
    if (snapshot.note === VISION_CREDITS_NOTE) credits = true;
  }

  if (credits) return { status: "credits", failing, since };
  if (failing >= UNAVAILABLE_RUN) return { status: "unavailable", failing, since };
  return { status: "ok", failing, since: null };
}
