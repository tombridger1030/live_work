import { revalidateCaptures } from "@/lib/cache";
import { getOptionalEnv } from "@/lib/env";
import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { captureUploadFromRequest, saveFrameSnapshot, type CaptureUpload } from "@/lib/capture-pipeline";
import { checkCaptureRateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/store";
import { isQuietNow } from "@/lib/time";
import { VisionAnalysisError } from "@/lib/vision";

export const runtime = "nodejs";

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "capture-agent";
}

export async function POST(request: Request): Promise<Response> {
  const captureSecret = getOptionalEnv("CAPTURE_SECRET");
  if (!isBearerAuthorized(request, captureSecret)) {
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
    capture = await captureUploadFromRequest(request, "agent");
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
    revalidateCaptures(); // refresh cached dashboard reads
    return Response.json({
      stored: true,
      id: result.snapshot.id,
      score: result.snapshot.score,
      status: result.snapshot.status,
      ...liveness
    });
  } catch (error) {
    if (error instanceof VisionAnalysisError) {
      return jsonError("Vision analysis failed", 502);
    }
    return jsonError("Capture failed", 500);
  }
}
