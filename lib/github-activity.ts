import {
  fetchCortalActivity,
  isGitHubActivityConfigured,
} from "@/lib/github";
import { revalidateCaptures } from "@/lib/cache";
import { getLedgerEntries, setLedgerEntry } from "@/lib/store";

// Compatibility: legacy Mac/day sync remains intact. The passive Vercel slice
// has its own persistence and never writes or depends on a published Ledger.
export { readCodePulse, readCodeDays, reconcileCodePulse } from "@/lib/code-persistence";

export type SyncedGitHubActivity = {
  commits: number;
  merges: number;
  lastCommitAt: string | null;
};

const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;
const nextRefreshAt = new Map<string, number>();
const inFlightRefreshes = new Map<string, Promise<void>>();

/**
 * Synchronizes one day's canonical GitHub activity into Ledger. Missing repo or
 * author configuration is an intentional no-op for public mirror deployments;
 * once configured, auth/API/store failures throw and the caller decides whether
 * stale saved counts are acceptable. The write replaces only server-owned
 * commit/merge fields and never changes manually logged Ledger data.
 */
export async function syncCortalActivity(
  dayIso: string,
): Promise<SyncedGitHubActivity | null> {
  if (!isGitHubActivityConfigured()) {
    return null;
  }
  const activity = await fetchCortalActivity(dayIso);
  const current = (await getLedgerEntries(dayIso, dayIso))[0];
  if (
    !current ||
    current.commits !== activity.commits ||
    current.merges !== activity.merges
  ) {
    await setLedgerEntry(dayIso, {
      commits: activity.commits,
      merges: activity.merges,
    });
    revalidateCaptures();
  }
  return activity;
}

/**
 * Schedules a stale-while-revalidate GitHub sync without delaying the caller.
 * At most one request per day runs at once and failed attempts cool down for one
 * minute, so repeated Ledger renders stay local and cannot stampede GitHub or
 * Keychain. A changed count republishes through `syncCortalActivity`; failures
 * preserve the last verified totals and are logged without credential content.
 */
export function refreshCortalActivitySoon(
  dayIso: string,
  now = Date.now(),
): void {
  if (
    !isGitHubActivityConfigured() ||
    inFlightRefreshes.has(dayIso) ||
    now < (nextRefreshAt.get(dayIso) ?? 0)
  ) {
    return;
  }
  nextRefreshAt.set(dayIso, now + ACTIVITY_REFRESH_INTERVAL_MS);
  const refresh = syncCortalActivity(dayIso)
    .then(() => undefined)
    .catch((error) => {
      console.warn(
        "[ledger] GitHub activity refresh failed:",
        (error as Error).message,
      );
    })
    .finally(() => {
      inFlightRefreshes.delete(dayIso);
    });
  inFlightRefreshes.set(dayIso, refresh);
}
