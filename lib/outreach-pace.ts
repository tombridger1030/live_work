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

/** True Monday to Friday: the only days with goals. Weekends are optional extra work. */
export function isOutreachDay(day: string): boolean {
  return mondayIndex(day) < 5;
}

/** Weekdays from `day` through Friday, counting `day` itself; 0 on a weekend. */
export function weekdaysLeft(day: string): number {
  return isOutreachDay(day) ? 5 - mondayIndex(day) : 0;
}

/**
 * How a bar spreads what is left of the week. Outreach spreads over the
 * weekdays left, because nothing new is sent on weekends. Hours spread over
 * every day left through Sunday, because the weekly hours goal includes the
 * weekend; weekend hours are where a short week catches up.
 */
export type PaceOptions = {
  decimals?: number;
  spreadOver?: "weekdays" | "week";
};

/**
 * One day's catch-up bar for one weekly number.
 *
 * @param weeklyGoal the week's goal, a finite number >= 0
 * @param loggedEarlier sent on earlier days of the same Monday-start week (not
 *   counting `day`), finite and >= 0. Excluding `day` is what keeps the bar
 *   still while the day itself is logged.
 * @param day a real YYYY-MM-DD day key
 * @param options.decimals precision the bar is rounded up to: 0 for counts
 *   (whole messages, the default), 1 for hours (tenths). An integer 0 to 3.
 * @param options.spreadOver "weekdays" (default) divides by the weekdays left;
 *   "week" divides by every day left through Sunday.
 * @returns null on Saturday and Sunday (weekends have no bars). Otherwise
 *   max(0, weeklyGoal - loggedEarlier) / days left, rounded up at `decimals`,
 *   so doing the shown amount always clears it. 0 means ahead of pace. No cap:
 *   a weekday-spread Friday that inherits the whole week asks for all of it.
 * @throws on a negative or non-finite count, an invalid day key, or invalid
 *   `decimals`.
 */
export function catchUpBar(
  weeklyGoal: number,
  loggedEarlier: number,
  day: string,
  { decimals = 0, spreadOver = "weekdays" }: PaceOptions = {},
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
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 3) {
    throw new Error(`catchUpBar needs 0 to 3 decimals, got ${decimals}`);
  }
  if (!isOutreachDay(day)) {
    return null;
  }
  const left =
    spreadOver === "weekdays" ? weekdaysLeft(day) : 7 - mondayIndex(day);
  const factor = 10 ** decimals;
  const share = Math.max(0, weeklyGoal - loggedEarlier) / left;
  // The epsilon keeps float noise (11.000000001) from rounding up a whole step.
  return Math.max(0, Math.ceil(share * factor - 1e-9) / factor);
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
 * How many new-prospect sends a bar requires, and how many of them are done.
 * Each channel is capped at its own bar before they are combined, so extra
 * emails never cover skipped requests.
 */
export function outreachRequirement(
  tally: OutreachTally,
  bar: OutreachGoal,
): { required: number; done: number } {
  if (bar.kind === "touches") {
    const required = Math.max(0, bar.touches);
    return { required, done: Math.min(tally.touches, required) };
  }
  const emails = Math.max(0, bar.emails);
  const requests = Math.max(0, bar.connectionRequests);
  return {
    required: emails + requests,
    done:
      Math.min(tally.emails, emails) +
      Math.min(tally.connectionRequests, requests),
  };
}

/** Share of an outreach bar cleared, 0 to 1. A bar of zero counts as met. */
export function outreachProgress(
  tally: OutreachTally,
  bar: OutreachGoal,
): number {
  const { required, done } = outreachRequirement(tally, bar);
  return required > 0 ? done / required : 1;
}

/** The bar as one number: touches, or emails plus requests. */
export function outreachBarTotal(bar: OutreachGoal): number {
  return bar.kind === "touches"
    ? bar.touches
    : bar.emails + bar.connectionRequests;
}

/**
 * True when a week's goal counts emails: a legacy touches goal (emails were
 * touches) or a channel goal with an email number. Goals saved since Oct 13,
 * 2026 ask for 0 emails, and their emails are bonus instead (see
 * `weeklyProgress`), so no email is ever counted twice.
 */
export function countsEmails(goal: OutreachGoal): boolean {
  return goal.kind === "touches" || goal.emails > 0;
}

/** What a week's outreach goal counts, in the owner's words: "touches", "requests", or "emails + requests". */
export function outreachGoalUnit(goal: OutreachGoal): string {
  if (goal.kind === "touches") {
    return "touches";
  }
  return countsEmails(goal) ? "emails + requests" : "requests";
}

/**
 * What counts toward a week's goal, as one uncapped number: every new touch
 * for a touches goal; requests, plus emails only when the goal counts them,
 * for a channel goal.
 */
export function outreachDone(tally: OutreachTally, goal: OutreachGoal): number {
  if (goal.kind === "touches") {
    return tally.touches;
  }
  return (countsEmails(goal) ? tally.emails : 0) + tally.connectionRequests;
}
