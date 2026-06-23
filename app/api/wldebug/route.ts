import { getOptionalEnv } from "@/lib/env";

export const runtime = "nodejs";

// TEMPORARY diagnostic route — delete after debugging the fabricated-snapshot bug.
export async function GET(): Promise<Response> {
  const fx = process.env.WORK_LIVE_VISION_FIXTURE;
  let fixtureNote: string | null = null;
  if (fx) {
    try {
      fixtureNote =
        (JSON.parse(fx) as { note?: string }).note ?? "(no note field)";
    } catch {
      fixtureNote = "(unparseable fixture)";
    }
  }
  return Response.json({
    nodeEnv: process.env.NODE_ENV ?? null,
    fixtureSet: Boolean(fx),
    fixtureLen: fx ? fx.length : 0,
    fixtureNote,
    anthropicKey: Boolean(getOptionalEnv("ANTHROPIC_API_KEY")),
    aiKey: Boolean(
      getOptionalEnv("AI_GATEWAY_API_KEY") ||
      getOptionalEnv("VERCEL_OIDC_TOKEN"),
    ),
    ownerSecretSet: Boolean(getOptionalEnv("OWNER_SECRET")),
  });
}
