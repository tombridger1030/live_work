import { revalidateCaptures } from "@/lib/cache";
import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { captureUploadFromRequest, saveFrameSnapshot, type CaptureUpload } from "@/lib/capture-pipeline";
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

  let capture: CaptureUpload | null;
  try {
    capture = await captureUploadFromRequest(request, "browser");
  } catch (error) {
    return jsonError((error as Error).message, 413);
  }
  if (!capture) {
    return jsonError("Missing frame", 400);
  }

  try {
    const result = await saveFrameSnapshot(capture, settings);
    const liveness =
      capture.source === "agent" && result.liveness
        ? { livenessStatus: result.liveness.status, livenessScore: result.liveness.score }
        : {};
    if (!result.stored || !result.snapshot) {
      return Response.json({ stored: false, score: result.score.score, status: result.score.status, ...liveness });
    }
    const checkin = await rollupCurrentHour(new Date(result.snapshot.capturedAt));
    revalidateCaptures(); // new data landed — refresh the cached dashboard reads
    return Response.json({
      stored: true,
      checkin,
      id: result.snapshot.id,
      score: result.snapshot.score,
      status: result.snapshot.status,
      ...liveness,
      visionProvider: result.visionProvider ?? null
    });
  } catch (error) {
    if (error instanceof VisionAnalysisError) {
      return jsonError("Vision analysis failed", 502);
    }
    return jsonError("Capture failed", 500);
  }
}
