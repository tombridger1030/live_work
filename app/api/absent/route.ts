import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { saveAbsentSnapshot } from "@/lib/capture-pipeline";
import { getOptionalEnv } from "@/lib/env";
import { checkCaptureRateLimit } from "@/lib/rate-limit";
import { rollupCurrentHour } from "@/lib/rollup";
import { getSettings } from "@/lib/store";
import { isQuietNow } from "@/lib/time";

export const runtime = "nodejs";

function clientKey(request: Request): string {
  return `absent:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "owner"}`;
}

/**
 * Records an "away" (score 0) snapshot when the capture agent could not open the
 * camera — the external webcam is disconnected, meaning the owner is not at the
 * Mac setup (gaming on PC, away from desk, etc.). Keeps the first away ticks on
 * the timeline, then lets AFK cadence thin redundant repeats instead of leaving
 * a gap. Owner-authed, and like capture it respects pause and quiet hours.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  const rateLimit = checkCaptureRateLimit(clientKey(request));
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Capture rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 3600) } }
    );
  }

  const settings = await getSettings();
  if (settings.paused) {
    return jsonError("Capture paused", 423);
  }
  if (isQuietNow()) {
    return jsonError("Capture closed (quiet hours)", 423);
  }

  const result = await saveAbsentSnapshot();
  if (!result.stored || !result.snapshot) {
    return Response.json({ stored: false, score: result.score.score, status: result.score.status });
  }
  const checkin = await rollupCurrentHour(new Date(result.snapshot.capturedAt));
  revalidateCaptures();
  return Response.json({ stored: true, id: result.snapshot.id, score: result.snapshot.score, status: result.snapshot.status, checkin });
}
