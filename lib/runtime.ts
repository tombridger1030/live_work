/** Returns a non-secret build identity for local watchdogs and support checks. */
export function runtimeBuildId(): string {
  return process.env.WORK_LIVE_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA || "unknown";
}
