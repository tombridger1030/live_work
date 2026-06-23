import { revalidateTag } from "next/cache";

export const CAPTURES_TAG = "captures";

/**
 * Bust the cached dashboard reads after a capture. Best-effort: `revalidateTag`
 * only works inside a request/render context, so a failure (e.g. when a route
 * handler is invoked directly in a unit test) is swallowed — a missed bust just
 * falls back to the cache's TTL rather than failing the capture.
 */
export function revalidateCaptures(): void {
  try {
    revalidateTag(CAPTURES_TAG);
  } catch {
    // No revalidation-capable context (tests); the TTL bounds staleness.
  }
}
