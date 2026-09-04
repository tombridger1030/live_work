import { isOwnerMutationAuthorized, jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { saveDashboardCriticalOverride } from "@/lib/dashboard-overrides";
import { getOptionalEnv } from "@/lib/env";
import { isMirrorHost, readMirror } from "@/lib/mirror";
import { setCriticalHour } from "@/lib/store";

export const runtime = "nodejs";

type Body = { day?: unknown; hour?: unknown; critical?: unknown };

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Marks one existing hourly check-in as critical or not critical for an
 * authenticated owner. The human flag is separate from machine rollups, so this
 * route never edits score fields. Tailscale Serve identity is the normal browser
 * path; a signed owner session is the fallback.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isOwnerMutationAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const { day, hour, critical } = body;
  if (typeof day !== "string" || !dayPattern.test(day)) {
    return jsonError("day must be YYYY-MM-DD", 400);
  }
  if (!Number.isInteger(hour) || typeof hour !== "number" || hour < 0 || hour > 23) {
    return jsonError("hour must be an integer from 0 to 23", 400);
  }
  if (typeof critical !== "boolean") {
    return jsonError("critical must be a boolean", 400);
  }

  if (isMirrorHost()) {
    const mirror = await readMirror(day);
    const existing = mirror?.data.hourly.find(
      (checkin) => checkin.day === day && checkin.hour === hour,
    );
    if (!existing) {
      return jsonError("Hourly check-in not found", 404);
    }
    await saveDashboardCriticalOverride(day, hour, critical);
    revalidateCaptures();
    return Response.json({
      checkin: { ...existing, critical },
    });
  }

  const checkin = await setCriticalHour(day, hour, critical);
  if (!checkin) {
    return jsonError("Hourly check-in not found", 404);
  }

  revalidateCaptures();
  return Response.json({ checkin });
}
