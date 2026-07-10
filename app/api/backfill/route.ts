import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { backfillBatch } from "@/lib/backfill";
import { revalidateCaptures } from "@/lib/cache";
import { getOptionalEnv } from "@/lib/env";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300; // owner-only bulk re-score; larger batches need >60s under direct Qwen

/**
 * Owner-only rubric backfill. Re-analyzes a batch of pre-rubric snapshots with
 * the current vision prompt + weights and recomputes the affected hourly
 * rollups. Call repeatedly with `?limit=` until the response `remaining` is 0;
 * it is resumable, so a rate-limited batch (`stopped: "model_error"`) is just
 * retried.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  // Blurred thumbnails are the only stored image; they cannot be re-read, so a
  // backfill while blur is on would overwrite good readings with garbage.
  if ((await getSettings()).blur) {
    return jsonError("Blur is on — stored thumbnails are blurred and cannot be re-analyzed.", 423);
  }

  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") ?? "5"), 1), 100);
  const result = await backfillBatch(limit);
  revalidateCaptures(); // corrected scores/rollups landed — refresh cached reads
  return Response.json(result);
}
