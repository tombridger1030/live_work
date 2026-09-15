import {
  captureFreshnessForMirror,
  captureHealthForMirror,
  readLatestMirror,
  readMirror,
} from "@/lib/mirror";

export const dynamic = "force-dynamic";

/** Reports only published capture facts; no browser request needs a Mac tunnel. */
export async function GET() {
  // Poll the same document the dashboard renders. During rollout the legacy
  // publisher may be newer than the archive; comparing them causes reload loops.
  const snapshot = await readMirror() ?? await readLatestMirror();
  if (!snapshot) return Response.json({ error: "Capture data is temporarily unavailable" }, { status: 503 });
  const captureHealth = captureHealthForMirror(snapshot);
  const captureFreshness = captureFreshnessForMirror(snapshot);
  return Response.json({
    latestId: captureHealth.lastImageId,
    capturedAt: captureHealth.lastImageAt,
    publishedAt: snapshot.publishedAt,
    captureHealth,
    captureFreshness,
  }, { headers: { "Cache-Control": "no-store" } });
}
