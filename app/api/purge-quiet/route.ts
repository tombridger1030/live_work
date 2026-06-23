import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { getOptionalEnv } from "@/lib/env";
import { countQuietHourData, purgeQuietHourData } from "@/lib/store";

export const runtime = "nodejs";

/**
 * Owner-authed maintenance: deletes stored snapshots + hourly rollups that fall
 * inside the current overnight quiet window (lib/time.ts), so historical data
 * matches the working hours after the window is narrowed. Idempotent — re-running
 * once the data is clean deletes nothing. Returns rows deleted and any remaining.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }
  const deleted = await purgeQuietHourData();
  const remaining = await countQuietHourData();
  revalidateCaptures();
  return Response.json({ deleted, remaining });
}
