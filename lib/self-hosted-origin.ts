// Where the real tally dashboard actually runs, and where its always-on copy is
// served from.
//
// The Vercel deployment serves a durable dashboard/Ledger mirror and write
// surface while forwarding live-only requests to this origin. Anything that
// needs the capture store still has to address this origin directly.
//
// Set WORK_LIVE_SELF_HOSTED_ORIGIN to move the dashboard. No trailing slash.
export const SELF_HOSTED_ORIGIN =
  process.env.WORK_LIVE_SELF_HOSTED_ORIGIN ??
  "https://toms-macbook-pro-1.tail0df074.ts.net";

// The public front doors that serve the mirror. The mirror page probes this Mac
// to decide whether to hand off to the live dashboard, which is a cross-origin
// read, so this Mac must name the origins allowed to make it (see
// app/api/status/route.ts). Comma-separated, no trailing slashes.
export const MIRROR_ORIGINS = (
  process.env.WORK_LIVE_MIRROR_ORIGINS ??
  "https://tally-focus.vercel.app,https://livework-one.vercel.app"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
