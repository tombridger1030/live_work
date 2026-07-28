// The notes capture writes when a person WAS detected locally but no vision model
// could read the frame.
//
// These live in their own module purely to keep the dependency graph honest.
// `lib/vision-health.ts` needs nothing but these two strings, and it is imported
// by /api/status — pulling them from `lib/vision` dragged OpenAI, sharp, and the
// whole COCO-SSD detector (all five weight shards) into a route that only
// compares text.
//
// They must have exactly one definition: capture writes them and the dashboard
// classifies health by matching them, so a second copy would silently break the
// outage banner.

/** A vision provider failed for some reason that usually clears itself. */
export const VISION_UNAVAILABLE_NOTE = "Vision unavailable; presence verified locally.";

/**
 * The AI account is out of money. Separate from the generic note because the two
 * need opposite reactions: a provider blip resolves on the next capture, an empty
 * account never does until somebody tops it up.
 */
export const VISION_CREDITS_NOTE = "Vision unavailable — AI provider credits exhausted; presence verified locally.";
