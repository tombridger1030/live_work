import { evaluateAndNudge } from "@/lib/accountability";
import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { getOptionalEnv } from "@/lib/env";

// Node runtime: the sweep uses the OpenAI SDK, Postgres, and GitHub/Telegram fetches.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron entrypoint for the accountability sweep. Called every ~5 minutes by a free
 * external scheduler with `Authorization: Bearer <CRON_SECRET>`. Missing/wrong
 * bearer -> 401 (fails closed when CRON_SECRET is unset). The sweep itself is
 * idempotent, so the exact cadence is not load-bearing.
 */
export async function POST(request: Request) {
  if (!isBearerAuthorized(request, getOptionalEnv("CRON_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }
  try {
    await evaluateAndNudge();
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[work-live] accountability sweep failed:", (error as Error).message);
    return jsonError("Accountability sweep failed", 500);
  }
}
