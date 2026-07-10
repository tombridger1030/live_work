import { buildHourlyCheckin } from "@/lib/rollup";
import { RUBRIC_VERSION, scoreFrom } from "@/lib/score";
import {
  countSnapshotsNeedingRubric,
  saveHourlyCheckin,
  snapshotThumbnailBytes,
  snapshotsForDay,
  snapshotsNeedingRubric,
  stampRubricVersion,
  updateSnapshotAnalysis
} from "@/lib/store";
import { localDayKey, localHour } from "@/lib/time";
import type { SnapshotRow } from "@/lib/types";
import { analyzeFrame } from "@/lib/vision";

export type BackfillResult = {
  processed: number; // snapshots re-analyzed in this batch
  skipped: number; // rows whose thumbnail was gone (stamped, reading kept)
  remaining: number; // snapshots still on an old rubric after this batch
  recomputedHours: number; // hourly rollups rebuilt this batch
  stopped: "done" | "batch_full" | "model_error";
};

/**
 * Re-analyzes one batch of pre-rubric snapshots against the current vision
 * prompt + weights, then recomputes the hourly rollups for every day it touched
 * (the heatmap aggregates those live, so it corrects itself).
 *
 * Resumable: each row is stamped with RUBRIC_VERSION as it is processed, so
 * re-invoking continues where it left off. A model error (e.g. a gateway rate
 * limit) ends the batch early but still recomputes the touched days and reports
 * `remaining`, so the caller just retries until `remaining` is 0.
 *
 * Precondition: capture blur is off (a blurred thumbnail cannot be re-read).
 */
export async function backfillBatch(limit: number): Promise<BackfillResult> {
  const pending = await snapshotsNeedingRubric(RUBRIC_VERSION, limit);
  const touchedDays = new Set<string>();
  let processed = 0;
  let skipped = 0;
  let modelError = false;

  for (const { id, capturedAt, rubricVersion, signals: currentSignals } of pending) {
    // v5 only changed score/status (present + headphones only). Rows already on
    // v4 have the correct person-detection presence signal, so they can be
    // re-scored from the stored signals without re-reading the thumbnail or
    // spending another Qwen call.
    if (rubricVersion === 4) {
      await updateSnapshotAnalysis(id, currentSignals, scoreFrom(currentSignals), RUBRIC_VERSION);
      processed += 1;
      touchedDays.add(localDayKey(new Date(capturedAt)));
      continue;
    }

    const bytes = await snapshotThumbnailBytes(id);
    if (!bytes) {
      await stampRubricVersion(id, RUBRIC_VERSION);
      skipped += 1;
      touchedDays.add(localDayKey(new Date(capturedAt)));
      continue;
    }
    try {
      const signals = await analyzeFrame(bytes);
      await updateSnapshotAnalysis(id, signals, scoreFrom(signals), RUBRIC_VERSION);
    } catch {
      modelError = true; // rate limit or transient model failure — stop, keep progress
      break;
    }
    processed += 1;
    touchedDays.add(localDayKey(new Date(capturedAt)));
  }

  let recomputedHours = 0;
  for (const day of touchedDays) {
    const byHour = new Map<number, SnapshotRow[]>();
    for (const snapshot of await snapshotsForDay(day)) {
      const hour = localHour(new Date(snapshot.capturedAt));
      const bucket = byHour.get(hour);
      if (bucket) {
        bucket.push(snapshot);
      } else {
        byHour.set(hour, [snapshot]);
      }
    }
    for (const [hour, snapshots] of byHour) {
      await saveHourlyCheckin(buildHourlyCheckin(day, hour, snapshots));
      recomputedHours += 1;
    }
  }

  const remaining = await countSnapshotsNeedingRubric(RUBRIC_VERSION);
  const stopped = modelError ? "model_error" : remaining === 0 ? "done" : "batch_full";
  return { processed, skipped, remaining, recomputedHours, stopped };
}
