import { isOwnerSessionAuthorized, jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { applySignalCorrection } from "@/lib/feedback";
import { buildHourlyCheckin } from "@/lib/rollup";
import { getOptionalEnv } from "@/lib/env";
import { checkFeedbackRateLimit } from "@/lib/rate-limit";
import { scoreFrom } from "@/lib/score";
import { correctSnapshot, getSnapshotById, recordFeedback, saveHourlyCheckin, snapshotsForDay } from "@/lib/store";
import { localDayKey, localHour } from "@/lib/time";
import type { Signals } from "@/lib/types";

export const runtime = "nodejs";

type Body = { snapshotId?: unknown; field?: unknown; value?: unknown };

/**
 * Signal correction. Flips one model signal on a snapshot to the human-supplied
 * truth, re-scores it, marks it human-verified (so the backfill never overwrites
 * it), recomputes its hour's rollup, and logs the correction as a labeled
 * example for a future learning loop.
 *
 * Owner-only. This was deliberately unauthenticated while the dashboard was
 * effectively private, but the record is publicly reachable now, and an open
 * write here let anyone scrape a snapshot id from the page and rewrite the
 * public accountability record — and poison the `human_verified` rows that the
 * corrections eval and the vision-model benchmark treat as ground truth.
 * Auth: the signed owner-session cookie (same boundary as ledger mutations),
 * which the dashboard already sends on this same-origin request.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isOwnerSessionAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  const rateLimit = checkFeedbackRateLimit();
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Feedback rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 3600) } }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonError("Invalid JSON", 400);
  }
  const { snapshotId, field, value } = body;
  if (typeof snapshotId !== "string" || typeof field !== "string") {
    return jsonError("snapshotId and field are required", 400);
  }

  const snapshot = await getSnapshotById(snapshotId);
  if (!snapshot) {
    return jsonError("Snapshot not found", 404);
  }

  const current: Signals = {
    present: snapshot.present,
    headphones: snapshot.headphones,
    eyesOnScreen: snapshot.eyesOnScreen,
    posture: snapshot.posture,
    note: snapshot.note
  };

  let signals: Signals;
  try {
    signals = applySignalCorrection(current, field, value);
  } catch (error) {
    return jsonError((error as Error).message, 400);
  }

  const score = scoreFrom(signals);
  await correctSnapshot(snapshotId, signals, score);
  await recordFeedback({
    snapshotId,
    field,
    oldValue: String(current[field as keyof Signals]),
    newValue: String(value)
  });

  // Recompute the affected hour so the bar + heatmap reflect the correction.
  const captured = new Date(snapshot.capturedAt);
  const day = localDayKey(captured);
  const hour = localHour(captured);
  const hourSnapshots = (await snapshotsForDay(day)).filter((row) => localHour(new Date(row.capturedAt)) === hour);
  await saveHourlyCheckin(buildHourlyCheckin(day, hour, hourSnapshots));

  revalidateCaptures();
  return Response.json({ id: snapshotId, score: score.score, status: score.status, signals });
}
