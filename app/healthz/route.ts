import { captureFreshnessFor, mergeCaptureHealthWithLatest, readCaptureHealth } from "@/lib/capture-health";
import { runtimeBuildId } from "@/lib/runtime";
import { readCaptureStoreStatus } from "@/lib/store";
import { isQuietNow } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Loopback readiness and capture liveness endpoint for the Mac watchdog.
 * Process/storage readiness is reported separately from image freshness so a
 * valid away fallback never masquerades as a healthy camera.
 */
export async function GET(): Promise<Response> {
  const now = new Date();
  try {
    const [{ settings, latest }, health] = await Promise.all([
      readCaptureStoreStatus(new Date(now.getTime() - 120 * 60_000)),
      readCaptureHealth(),
    ]);
    const captureHealth = mergeCaptureHealthWithLatest(health, latest);
    const freshness = captureFreshnessFor(captureHealth, settings, now);
    return Response.json({
      status: "ready",
      buildId: runtimeBuildId(),
      store: "ok",
      paused: settings.paused,
      quiet: isQuietNow(now),
      latestId: latest?.id ?? null,
      captureHealth,
      captureFreshness: freshness,
    });
  } catch (error) {
    return Response.json({
      status: "unhealthy",
      buildId: runtimeBuildId(),
      store: "unavailable",
      failure: "storage_failed",
      message: (error as Error).message.slice(0, 180),
    }, { status: 503 });
  }
}
