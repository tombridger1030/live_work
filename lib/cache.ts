import { revalidateTag } from "next/cache";
import { refreshMirrorSoon } from "@/lib/mirror";

export const CAPTURES_TAG = "captures";

/**
 * The single "capture data changed" signal.
 *
 * Busts the cached dashboard reads, and republishes the offline mirror so the
 * public URL keeps answering with fresh numbers once this Mac goes to sleep.
 * Both are best-effort: `revalidateTag` only works inside a request/render
 * context, so a failure (e.g. when a route handler is invoked directly in a unit
 * test) is swallowed — a missed bust just falls back to the cache's TTL rather
 * than failing the capture. The mirror refresh never blocks and never throws.
 */
export function revalidateCaptures(): void {
  try {
    revalidateTag(CAPTURES_TAG);
  } catch {
    // No revalidation-capable context (tests); the TTL bounds staleness.
  }
  refreshMirrorSoon();
}
