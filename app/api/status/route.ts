import { captureCadenceFor, captureCadenceLookbackMinutes } from "@/lib/capture-cadence";
import { getSettings, latestSnapshot, snapshotsSince } from "@/lib/store";
import { isQuietNow } from "@/lib/time";

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
      capture: settings.paused || quiet ? { ...capture, due: false } : capture
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
      }
    }
  );
}
