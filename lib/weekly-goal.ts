import type { OutreachGoal } from "@/lib/outreach-pace";
import { isMondayWeekStart, isValidDayKey } from "@/lib/time";
import type { WeeklyGoal } from "@/lib/types";

export const WEEKLY_GOAL_MAX_COUNT = 10000;
export const WEEKLY_GOAL_MIN_HOURS = 0.1;
export const WEEKLY_GOAL_MAX_HOURS = 168;

export type WeeklyGoalValidation = { ok: true } | { ok: false; error: string };

function isGoalCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= WEEKLY_GOAL_MAX_COUNT
  );
}

function isGoalHours(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= WEEKLY_GOAL_MIN_HOURS &&
    value <= WEEKLY_GOAL_MAX_HOURS
  );
}

/**
 * Validates a goal the owner is saving, once for route, store, and UI use.
 * Every new goal is connection requests per week (a whole number from 1 to
 * 10000) and finite hours, effective from a real Monday. Emails are bonus,
 * never a goal (owner decision, 2026-10-13).
 */
export function validateWeeklyGoal(
  weekStart: unknown,
  connectionRequests: unknown,
  hours: unknown,
): WeeklyGoalValidation {
  if (typeof weekStart !== "string" || !isMondayWeekStart(weekStart)) {
    return { ok: false, error: "weekStart must be a real Monday YYYY-MM-DD" };
  }
  if (!isGoalCount(connectionRequests) || connectionRequests < 1) {
    return {
      ok: false,
      error: `weeklyConnectionRequests must be an integer from 1 to ${WEEKLY_GOAL_MAX_COUNT}`,
    };
  }
  if (!isGoalHours(hours)) {
    return {
      ok: false,
      error: `weeklyHours must be a number from ${WEEKLY_GOAL_MIN_HOURS} to ${WEEKLY_GOAL_MAX_HOURS}`,
    };
  }
  return { ok: true };
}

/**
 * The stored shape of a goal saved now: a channel goal asking for 0 emails,
 * which makes that week's emails bonus (see `countsEmails`). The one place
 * new goals are built. Precondition: the inputs passed `validateWeeklyGoal`.
 */
export function connectionRequestGoal(
  weekStart: string,
  connectionRequests: number,
  hours: number,
): WeeklyGoal {
  return channelWeeklyGoal(weekStart, 0, connectionRequests, hours);
}

/**
 * The stored shape of a channel goal, including weeks saved with an email
 * number before Oct 13, 2026. `reachouts` is kept as the sum so the Postgres
 * NOT NULL column and older readers of the overlay stay valid.
 */
export function channelWeeklyGoal(
  weekStart: string,
  emails: number,
  connectionRequests: number,
  hours: number,
): WeeklyGoal {
  return {
    weekStart,
    reachouts: emails + connectionRequests,
    hours,
    emails,
    connectionRequests,
  };
}

/**
 * Accepts a stored goal of either generation: a legacy touches goal
 * (`reachouts`, `hours`) or a channel goal whose `reachouts` equals
 * `emails + connectionRequests`. Used where stored goals cross a trust boundary.
 */
export function isStoredWeeklyGoal(
  value: unknown,
): value is Omit<WeeklyGoal, "weekStart"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const goal = value as Record<string, unknown>;
  if (
    !isGoalCount(goal.reachouts) ||
    goal.reachouts < 1 ||
    !isGoalHours(goal.hours)
  ) {
    return false;
  }
  if (goal.emails === undefined && goal.connectionRequests === undefined) {
    return true;
  }
  return (
    isGoalCount(goal.emails) &&
    isGoalCount(goal.connectionRequests) &&
    goal.emails + goal.connectionRequests === goal.reachouts
  );
}

/**
 * The first week whose emails are bonus whatever its stored goal says (owner
 * decision, 2026-10-13). The Oct 12-18 goal was saved with 50 emails the day
 * before; weeks before it keep the email goals they were saved with.
 */
export const EMAILS_BONUS_FROM_WEEK = "2026-10-12";

/**
 * The outreach goal a stored row sets for one week: per channel when the row
 * has channels. From EMAILS_BONUS_FROM_WEEK on, a channel goal asks for 0
 * emails, so its emails are bonus (see `countsEmails`) and its day bars ask
 * for requests only. Example: the row {emails 50, connectionRequests 250}
 * scores the week of Oct 5 as 50 emails and 250 requests, and the weeks of
 * Oct 12 and Oct 19 as 250 requests.
 *
 * @param forWeek YYYY-MM-DD start of the week being scored. A goal carries
 *   forward to later weeks, so this is not the row's own `weekStart`.
 * @throws on a `forWeek` that is not a real day key, which would otherwise
 *   compare as earlier than Oct 12 and quietly ask for emails.
 */
export function outreachGoalOf(
  goal: Pick<WeeklyGoal, "reachouts" | "emails" | "connectionRequests">,
  forWeek: string,
): OutreachGoal {
  if (!isValidDayKey(forWeek)) {
    throw new Error(`outreachGoalOf needs a YYYY-MM-DD week, got ${forWeek}`);
  }
  if (goal.emails !== undefined && goal.connectionRequests !== undefined) {
    return {
      kind: "channels",
      emails: forWeek >= EMAILS_BONUS_FROM_WEEK ? 0 : goal.emails,
      connectionRequests: goal.connectionRequests,
    };
  }
  return { kind: "touches", touches: goal.reachouts };
}

/** The stored row for a resolved outreach goal; inverse of `outreachGoalOf`. */
export function storedWeeklyGoal(
  weekStart: string,
  outreach: OutreachGoal,
  hours: number,
): WeeklyGoal {
  return outreach.kind === "touches"
    ? { weekStart, reachouts: outreach.touches, hours }
    : channelWeeklyGoal(
        weekStart,
        outreach.emails,
        outreach.connectionRequests,
        hours,
      );
}
