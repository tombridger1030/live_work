import { isSnapshotFresh, minutesSince } from "@/lib/time";
import type { DisplayStatus, Settings, SnapshotRow } from "@/lib/types";

export type PublicStatusState = {
  displayStatus: DisplayStatus;
  headline: string;
  lastCheckedText: string;
  stale: boolean;
};

export const statusLabels: Record<DisplayStatus, string> = {
  locked_in: "LOCKED IN",
  present: "AT DESK",
  away: "AWAY",
  paused: "PAUSED",
  no_recent_data: "NO RECENT DATA"
};

/**
 * Converts persisted state into the only status the public page may display.
 *
 * Preconditions: `latest` is either null or a stored snapshot; `settings`
 * reflects owner toggles. Postconditions: stale, missing, or paused state never
 * returns an affirmative display status.
 */
export function publicStatusFor(
  latest: SnapshotRow | null,
  settings: Settings,
  now = new Date()
): PublicStatusState {
  if (settings.paused) {
    return {
      displayStatus: "paused",
      headline: statusLabels.paused,
      lastCheckedText: "Capture paused",
      stale: false
    };
  }

  if (!latest) {
    return {
      displayStatus: "no_recent_data",
      headline: statusLabels.no_recent_data,
      lastCheckedText: "No checks yet",
      stale: true
    };
  }

  if (!isSnapshotFresh(latest.capturedAt, now)) {
    return {
      displayStatus: "no_recent_data",
      headline: statusLabels.no_recent_data,
      lastCheckedText: `Last checked ${minutesSince(latest.capturedAt, now)} min ago`,
      stale: true
    };
  }

  return {
    displayStatus: latest.status,
    headline: statusLabels[latest.status],
    lastCheckedText: `Last checked ${minutesSince(latest.capturedAt, now)} min ago`,
    stale: false
  };
}
