import { jsonError } from "@/lib/auth";
import { revalidateCaptures } from "@/lib/cache";
import { setCriticalHour } from "@/lib/store";

export const runtime = "nodejs";

type Body = { day?: unknown; hour?: unknown; critical?: unknown };

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Marks one existing hourly check-in as critical or not critical. The human flag
 * is separate from machine rollups, so this route never edits score fields.
 */
export async function POST(request: Request): Promise<Response> {
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

  const checkin = await setCriticalHour(day, hour, critical);
  if (!checkin) {
    return jsonError("Hourly check-in not found", 404);
  }

  revalidateCaptures();
  return Response.json({ checkin });
}
