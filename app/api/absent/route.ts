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
 * camera — e.g. the external webcam is unplugged, which means the owner is away
 * from the setup. Keeps the timeline continuous instead of leaving a gap. Owner-
 * authed, and like capture it respects pause and quiet hours.
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

  const snapshot = await saveAbsentSnapshot();
  const checkin = await rollupCurrentHour(new Date(snapshot.capturedAt));
  revalidateCaptures();
  return Response.json({ id: snapshot.id, score: snapshot.score, status: snapshot.status, checkin });
}
