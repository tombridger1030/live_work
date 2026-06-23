import { getOptionalEnv } from "@/lib/env";
import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { rollupPreviousHour } from "@/lib/rollup";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const cronSecret = getOptionalEnv("CRON_SECRET");
  if (!isBearerAuthorized(request, cronSecret)) {
    return jsonError("Unauthorized", 401);
  }

  return Response.json({ checkin: await rollupPreviousHour() });
}
