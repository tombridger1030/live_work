import { revalidateCaptures } from "@/lib/cache";
import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { captureUploadFromRequest, saveFrameSnapshot, type CaptureUpload } from "@/lib/capture-pipeline";
import { getOptionalEnv } from "@/lib/env";
import { checkCaptureRateLimit } from "@/lib/rate-limit";
import { rollupCurrentHour } from "@/lib/rollup";
import { getSettings, snapshotForCaptureAttempt } from "@/lib/store";
import { isQuietNow } from "@/lib/time";
import { VisionAnalysisError } from "@/lib/vision";
import {
  captureFailureClassForError,
  recordCaptureAttempt,
  recordCaptureFailure,
  recordCaptureImage,
} from "@/lib/capture-health";

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

  const captureAttemptId = request.headers.get("x-capture-attempt-id")?.trim() || null;
  if (captureAttemptId) await recordCaptureAttempt();
  const replay = captureAttemptId ? await snapshotForCaptureAttempt(captureAttemptId) : null;
  if (replay) {
    await recordCaptureImage(replay.id);
    return Response.json({
      stored: true,
      id: replay.id,
      score: replay.score,
      status: replay.status,
      replayed: true,
    });
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    if (captureAttemptId) await recordCaptureFailure("storage_failed", (error as Error).message);
    return jsonError("Capture store unavailable", 503);
  }
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
    if (captureAttemptId) await recordCaptureFailure("upload_failed", (error as Error).message);
    return jsonError((error as Error).message, 413);
  }
  if (!capture) {
    return jsonError("Missing frame", 400);
  }

  try {
    const result = await saveFrameSnapshot(capture, settings);
    if (captureAttemptId) await recordCaptureImage(result.snapshot?.id ?? null);
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
      if (captureAttemptId) await recordCaptureFailure("provider_failed", error.message);
      return jsonError("Vision analysis failed", 502);
    }
    if (captureAttemptId) await recordCaptureFailure(captureFailureClassForError(error), (error as Error).message);
    return jsonError("Capture failed", 500);
  }
}
