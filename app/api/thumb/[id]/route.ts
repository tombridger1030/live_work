import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { jsonError } from "@/lib/auth";
import { snapshotThumbnail } from "@/lib/store";

export const runtime = "nodejs";

// Snapshots are immutable and ids are unique, so a thumbnail can be cached
// forever by the browser — the page ships this URL instead of inline base64.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return jsonError("Invalid thumbnail id", 400);
  }

  // Local dev stores thumbnails on disk.
  const filePath = path.join(process.cwd(), ".work-live", "thumbs", `${id}.jpg`);
  if (existsSync(filePath)) {
    return new Response(await readFile(filePath), {
      headers: { "Cache-Control": IMMUTABLE_CACHE, "Content-Type": "image/jpeg" }
    });
  }

  // Deployed: the bytes live in the snapshot row as a data URI (or a Blob URL).
  const stored = await snapshotThumbnail(id);
  if (!stored) {
    return jsonError("Thumbnail not found", 404);
  }
  if (stored.startsWith("data:")) {
    const base64 = stored.slice(stored.indexOf(",") + 1);
    return new Response(Buffer.from(base64, "base64"), {
      headers: { "Cache-Control": IMMUTABLE_CACHE, "Content-Type": "image/jpeg" }
    });
  }
  return Response.redirect(stored, 308);
}
