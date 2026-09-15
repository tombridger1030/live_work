import {
  captureCadenceFor,
  captureCadenceLookbackMinutes,
} from "@/lib/capture-cadence";
import { MIRROR_ORIGINS } from "@/lib/self-hosted-origin";
import { readCaptureStoreStatus } from "@/lib/store";
import { isQuietNow } from "@/lib/time";
import { visionHealthFrom } from "@/lib/vision-health";
import { captureFreshnessFor, mergeCaptureHealthWithLatest, readCaptureHealth } from "@/lib/capture-health";
import { runtimeBuildId } from "@/lib/runtime";

export const runtime = "nodejs";

/**
 * Lets the mirror page read this response cross-origin so it can tell "this Mac
 * is awake" from "the tunnel answered but nothing is behind it" — an opaque
 * no-cors probe cannot, and would hand visitors off to a dead page.
 *
 * Reflected from an allowlist rather than sent as `*`: the body is already public
 * through the funnel, but there is no reason to let any site on the internet poll
 * whether this particular machine is awake. No credentials are involved.
 */
function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !MIRROR_ORIGINS.includes(origin)) {
    return {};
  }
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeadersFor(request),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const now = new Date();
  const lookbackStart = new Date(
    now.getTime() - captureCadenceLookbackMinutes * 60_000,
  );
  const [{ settings, latest, recentSnapshots }, health] = await Promise.all([
    readCaptureStoreStatus(lookbackStart),
    readCaptureHealth(),
  ]);
  const quiet = isQuietNow(now);
  const capture = captureCadenceFor(latest, recentSnapshots, now);
  const captureHealth = mergeCaptureHealthWithLatest(health, latest);
  const freshness = captureFreshnessFor(captureHealth, settings, now);
  return Response.json(
    {
      buildId: runtimeBuildId(),
      paused: settings.paused,
      quiet,
      latestId: latest?.id ?? null,
      captureHealth,
      captureFreshness: freshness,
      // Surfaced here as well as on the page so the capture agent and any external
      // monitor can see a vision outage without scraping HTML.
      vision: visionHealthFrom(recentSnapshots, now),
      capture: settings.paused || quiet ? { ...capture, due: false } : capture,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30",
        ...corsHeadersFor(request),
      },
    },
  );
}
