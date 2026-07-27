import { jsonError } from "@/lib/auth";
import { snapshotThumbnail, snapshotThumbnailBytes } from "@/lib/store";

export const runtime = "nodejs";

// Snapshots are immutable and ids are unique, so a thumbnail can be cached
// forever by the browser — the page ships this URL instead of inline base64.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return jsonError("Invalid thumbnail id", 400);
  }

  // WHERE the bytes live is the store's decision (Postgres data URI, Blob URL, or
  // a file under WORK_LIVE_DATA_DIR). This route must never duplicate that path
  // logic: doing so previously broke every thumbnail whenever the data root moved
  // off the default, and turned a miss into a 500 (relative-URL redirect).
  const stored = await snapshotThumbnail(id);

  if (stored?.startsWith("data:")) {
    // Postgres with no object store: bytes are inline on the row.
    return new Response(Buffer.from(stored.slice(stored.indexOf(",") + 1), "base64"), {
      headers: { "Cache-Control": IMMUTABLE_CACHE, "Content-Type": "image/jpeg" }
    });
  }

  if (stored?.startsWith("https://")) {
    // Blob-hosted: redirect so the bytes never pass through this function.
    return Response.redirect(stored, 308);
  }

  // Local store: the store reads the file from its own data root.
  const bytes = await snapshotThumbnailBytes(id);
  if (!bytes) {
    return jsonError("Thumbnail not found", 404);
  }
  return new Response(Buffer.from(bytes), {
    headers: { "Cache-Control": IMMUTABLE_CACHE, "Content-Type": "image/jpeg" }
  });
}
