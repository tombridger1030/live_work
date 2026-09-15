import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { getOptionalEnv } from "@/lib/env";
import { recordCaptureFailure } from "@/lib/capture-health";
import type { CaptureFailureClass } from "@/lib/types";

export const runtime = "nodejs";

const failureClasses: CaptureFailureClass[] = [
  "status_unavailable",
  "camera_unavailable",
  "upload_failed",
  "authentication_failed",
  "storage_failed",
  "provider_failed",
  "mirror_failed",
  "unknown",
];

/**
 * Owner-authenticated local-only endpoint for failures that happen before a
 * snapshot request reaches the capture routes, such as a dead status check.
 * The record is intentionally small and secret-free so health survives a
 * process restart without becoming another source of capture data.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }
  try {
    const body = await request.json() as { failure?: unknown; message?: unknown };
    const failure = typeof body.failure === "string" && failureClasses.includes(body.failure as CaptureFailureClass)
      ? body.failure as CaptureFailureClass
      : "unknown";
    const message = typeof body.message === "string" ? body.message : null;
    await recordCaptureFailure(failure, message);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError("Capture health update failed", 400);
  }
}
