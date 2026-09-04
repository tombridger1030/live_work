import { readArchiveAsset } from "@/lib/mirror-archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Intentionally public, matching app/page.tsx. Private Blob protects storage
// credentials, not dashboard visibility. This route stays outside /api redirects.
export async function GET(_request: Request, context: { params: Promise<{ day: string; id: string }> }): Promise<Response> {
  const { day, id } = await context.params;
  return readArchiveAsset(day, id);
}
