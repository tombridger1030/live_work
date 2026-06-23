import { revalidateCaptures } from "@/lib/cache";
import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { frameFromRequest, saveFrameSnapshot } from "@/lib/capture-pipeline";
import { getOptionalEnv } from "@/lib/env";
import { checkCaptureRateLimit } from "@/lib/rate-limit";
import { rollupCurrentHour } from "@/lib/rollup";
import { getSettings } from "@/lib/store";
import { isQuietNow } from "@/lib/time";
import { VisionAnalysisError } from "@/lib/vision";

export const runtime = "nodejs";

function clientKey(request: Request): string {
  return `browser:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "owner"}`;
}

export async function POST(request: Request): Promise<Response> {
  const ownerSecret = getOptionalEnv("OWNER_SECRET");
  if (!isBearerAuthorized(request, ownerSecret)) {
    return jsonError("Unauthorized", 401);
  }

  const rateLimit = checkCaptureRateLimit(clientKey(request));
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Capture rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds ?? 3600)
        }
      }
    );
  }

  const settings = await getSettings();
  if (settings.paused) {
    return jsonError("Capture paused", 423);
  }
  if (isQuietNow()) {
    return jsonError("Capture closed (quiet hours)", 423);
  }

  let frame: Uint8Array | null;
  try {
    frame = await frameFromRequest(request);
  } catch (error) {
    return jsonError((error as Error).message, 413);
  }
  if (!frame) {
    return jsonError("Missing frame", 400);
  }

  try {
    const snapshot = await saveFrameSnapshot(frame, settings);
    const checkin = await rollupCurrentHour(new Date(snapshot.capturedAt));
    revalidateCaptures(); // new data landed — refresh the cached dashboard reads
    return Response.json({
      checkin,
      id: snapshot.id,
      score: snapshot.score,
      status: snapshot.status
    });
  } catch (error) {
    if (error instanceof VisionAnalysisError) {
      return jsonError("Vision analysis failed", 502);
    }
    return jsonError("Capture failed", 500);
  }
}
