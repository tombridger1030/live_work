import { isBearerAuthorized } from "@/lib/auth";
import { cleanupArchive } from "@/lib/mirror-archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Removes only expired deployed archive objects; local source and owner edits survive. */
export async function GET(request: Request) {
  if (!isBearerAuthorized(request, process.env.CRON_SECRET ?? null)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const deleted = await cleanupArchive({ dryRun: false });
    return Response.json({ deleted: deleted.length });
  } catch {
    return Response.json({ error: "Archive maintenance could not finish" }, { status: 503 });
  }
}
