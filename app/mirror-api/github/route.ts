import { readCodePulse } from "@/lib/code-persistence";
import { isValidDayKey } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Like the existing public dashboard, this exposes aggregate counts only.
// A read never starts paid GitHub work and never returns private Blob URLs.
export async function GET(request: Request): Promise<Response> {
  const day = new URL(request.url).searchParams.get("day") ?? undefined;
  if (day !== undefined && !isValidDayKey(day)) return Response.json({ error: "Invalid day" }, { status: 400 });
  try {
    return Response.json(await readCodePulse(undefined, Date.now(), day), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Code Pulse unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
