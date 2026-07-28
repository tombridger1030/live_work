import { captureCadenceFor, captureCadenceLookbackMinutes } from "@/lib/capture-cadence";
import { getSettings, latestSnapshot, snapshotsSince } from "@/lib/store";
import { isQuietNow } from "@/lib/time";
import { visionHealthFrom } from "@/lib/vision-health";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const now = new Date();
  const lookbackStart = new Date(now.getTime() - captureCadenceLookbackMinutes * 60_000);
  const [settings, latest, recentSnapshots] = await Promise.all([
    getSettings(),
    latestSnapshot(),
    snapshotsSince(lookbackStart)
  ]);
  const quiet = isQuietNow(now);
  const capture = captureCadenceFor(latest, recentSnapshots, now);
  return Response.json(
    {
      paused: settings.paused,
      quiet,
      latestId: latest?.id ?? null,
      // Surfaced here as well as on the page so the capture agent and any external
      // monitor can see a vision outage without scraping HTML.
      vision: visionHealthFrom(recentSnapshots, now),
      capture: settings.paused || quiet ? { ...capture, due: false } : capture
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30"
      }
    }
  );
}
