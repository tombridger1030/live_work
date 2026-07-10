import { isBearerAuthorized, jsonError } from "@/lib/auth";
import { getOptionalEnv } from "@/lib/env";
import { humanVerifiedCases, manualOverrideCaseCount } from "@/lib/store";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");
  const value = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

/**
 * Owner-authenticated export of the human-corrected snapshots — the regression
 * set for the capture agent's false positives / false negatives. `cases` are
 * rows with an explicit signal correction (a feedback row); `present`/
 * `headphones` are human truth only for the fields in `correctedFields`.
 * `manualOverridesExcluded` counts owner-confirmed not-working windows that were
 * marked away without a signal correction — they stay visible but are not
 * physical-presence detector labels, so the eval does not score them. `thumbUrl`
 * is the retained frame the eval re-runs the pipeline against (raw frames are
 * never stored). Auth: Bearer OWNER_SECRET (same boundary as maintenance routes).
 */
export async function GET(request: Request): Promise<Response> {
  if (!isBearerAuthorized(request, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  const [cases, manualOverridesExcluded] = await Promise.all([
    humanVerifiedCases(parseLimit(request)),
    manualOverrideCaseCount(),
  ]);
  return Response.json({
    manualOverridesExcluded,
    cases: cases.map((entry) => ({
      id: entry.id,
      capturedAt: entry.capturedAt,
      present: entry.present,
      headphones: entry.headphones,
      correctedFields: entry.correctedFields,
      thumbUrl: `/api/thumb/${entry.id}`,
    })),
  });
}
