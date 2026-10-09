import { newTouches, type ManualCounts } from "@/lib/ledger-fields";
import { isValidDayKey } from "@/lib/time";

// Outreach pace: the single source of how a weekly outreach goal becomes one
// day's bar. Sends only happen Monday to Friday, and the bar catches up on
// whatever earlier days of the week left undone.

/**
 * A week's outreach goal, or one day's share of it. Weeks saved before the
 * channel split carry one combined touches number; later weeks carry one
 * number per channel.
 */
export type OutreachGoal =
  | { kind: "touches"; touches: number }
  | { kind: "channels"; emails: number; connectionRequests: number };

/** What has been sent, in every unit an outreach goal can be measured in. */
export type OutreachTally = {
  touches: number;
  emails: number;
  connectionRequests: number;
};

export function outreachTally(
  counts: Pick<ManualCounts, "reachouts" | "emailsSent" | "connectionRequests">,
): OutreachTally {
  return {
    touches: newTouches(counts),
    emails: counts.emailsSent,
    connectionRequests: counts.connectionRequests,
  };
}

// Monday-first weekday index: 0 = Mon ... 6 = Sun.
function mondayIndex(day: string): number {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/** True Monday to Friday: the only days outreach is expected. */
export function isOutreachDay(day: string): boolean {
  return mondayIndex(day) < 5;
}

/** Weekdays from `day` through Friday, counting `day` itself; 0 on a weekend. */
export function weekdaysLeft(day: string): number {
  return isOutreachDay(day) ? 5 - mondayIndex(day) : 0;
}

/**
 * One day's catch-up bar for one weekly number.
 *
 * @param weeklyGoal the week's goal, a finite number >= 0
 * @param loggedEarlier sent on earlier days of the same Monday-start week (not
 *   counting `day`), finite and >= 0. Excluding `day` is what keeps the bar
 *   still while the day itself is logged.
 * @param day a real YYYY-MM-DD day key
 * @returns null on Saturday and Sunday (no bar at all). Otherwise
 *   ceil(max(0, weeklyGoal - loggedEarlier) / weekdaysLeft(day)): a whole
 *   number, so sending the shown number always clears it. 0 means ahead of
 *   pace. No cap: a Friday that inherits the whole week asks for all of it.
 * @throws on a negative or non-finite count or an invalid day key.
 */
export function catchUpBar(
  weeklyGoal: number,
  loggedEarlier: number,
  day: string,
): number | null {
  if (
    !Number.isFinite(weeklyGoal) ||
    weeklyGoal < 0 ||
    !Number.isFinite(loggedEarlier) ||
    loggedEarlier < 0
  ) {
    throw new Error(
      `catchUpBar needs finite counts >= 0, got goal ${weeklyGoal}, logged ${loggedEarlier}`,
    );
  }
  if (!isValidDayKey(day)) {
    throw new Error(`catchUpBar needs a YYYY-MM-DD day, got ${day}`);
  }
  const left = weekdaysLeft(day);
  if (left === 0) {
    return null;
  }
  return Math.ceil(Math.max(0, weeklyGoal - loggedEarlier) / left);
}

/**
 * One day's outreach bar in the same shape as the week's goal: one catch-up
 * bar per number in it. Returns null on weekends.
 */
export function dailyOutreachBar(
  goal: OutreachGoal,
  loggedEarlier: OutreachTally,
  day: string,
): OutreachGoal | null {
  if (goal.kind === "touches") {
    const touches = catchUpBar(goal.touches, loggedEarlier.touches, day);
    return touches === null ? null : { kind: "touches", touches };
  }
  const emails = catchUpBar(goal.emails, loggedEarlier.emails, day);
  const connectionRequests = catchUpBar(
    goal.connectionRequests,
    loggedEarlier.connectionRequests,
    day,
  );
  return emails === null || connectionRequests === null
    ? null
    : { kind: "channels", emails, connectionRequests };
}

/**
 * Share of an outreach bar cleared, 0 to 1. Each channel is capped at its own
 * bar before they are combined, so extra emails never cover skipped requests.
 * A bar of zero counts as met.
 */
export function outreachProgress(
  tally: OutreachTally,
  bar: OutreachGoal,
): number {
  if (bar.kind === "touches") {
    return bar.touches > 0 ? Math.min(1, tally.touches / bar.touches) : 1;
  }
  const total = bar.emails + bar.connectionRequests;
  if (total <= 0) {
    return 1;
  }
  return (
    (Math.min(tally.emails, bar.emails) +
      Math.min(tally.connectionRequests, bar.connectionRequests)) /
    total
  );
}

/** The bar as one number: touches, or emails plus requests. */
export function outreachBarTotal(bar: OutreachGoal): number {
  return bar.kind === "touches"
    ? bar.touches
    : bar.emails + bar.connectionRequests;
}

/** What counts toward a bar of this kind, as one number. */
export function outreachDone(tally: OutreachTally, bar: OutreachGoal): number {
  return bar.kind === "touches"
    ? tally.touches
    : tally.emails + tally.connectionRequests;
}
