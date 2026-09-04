import { readLatestMirror, readMirror } from "@/lib/mirror";

export const dynamic = "force-dynamic";

/** Reports only published capture facts; no browser request needs a Mac tunnel. */
export async function GET() {
  // Poll the same document the dashboard renders. During rollout the legacy
  // publisher may be newer than the archive; comparing them causes reload loops.
  const snapshot = await readMirror() ?? await readLatestMirror();
  if (!snapshot) return Response.json({ error: "Capture data is temporarily unavailable" }, { status: 503 });
  return Response.json({
    latestId: snapshot.data.latest?.id ?? null,
    capturedAt: snapshot.data.latest?.capturedAt ?? null,
    publishedAt: snapshot.publishedAt,
  }, { headers: { "Cache-Control": "no-store" } });
}
