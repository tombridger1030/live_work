import { isBearerAuthorized } from "@/lib/auth";
import { logCodeFailure, reconcileCodePulse } from "@/lib/code-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, process.env.CRON_SECRET ?? null)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const status = await reconcileCodePulse();
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logCodeFailure("route", error);
    return Response.json({ error: "Refresh failed; saved activity preserved" }, { status: 503 });
  }
}

export const POST = GET;
