import type { OutreachGoal } from "@/lib/outreach-pace";
import { isMondayWeekStart } from "@/lib/time";
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
 * Every new goal is per channel: whole-number emails and connection requests
 * per week (0 to 10000 each, at least one between them) and finite hours,
 * effective from a real Monday.
 */
export function validateWeeklyGoal(
  weekStart: unknown,
  emails: unknown,
  connectionRequests: unknown,
  hours: unknown,
): WeeklyGoalValidation {
  if (typeof weekStart !== "string" || !isMondayWeekStart(weekStart)) {
    return { ok: false, error: "weekStart must be a real Monday YYYY-MM-DD" };
  }
  if (!isGoalCount(emails)) {
    return {
      ok: false,
      error: `weeklyEmails must be an integer from 0 to ${WEEKLY_GOAL_MAX_COUNT}`,
    };
  }
  if (!isGoalCount(connectionRequests)) {
    return {
      ok: false,
      error: `weeklyConnectionRequests must be an integer from 0 to ${WEEKLY_GOAL_MAX_COUNT}`,
    };
  }
  if (emails + connectionRequests < 1) {
    return {
      ok: false,
      error: "weeklyEmails and weeklyConnectionRequests cannot both be 0",
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
 * The stored shape of a channel goal. `reachouts` is kept as the sum so the
 * Postgres NOT NULL column and older readers of the overlay stay valid.
 * Precondition: the inputs passed `validateWeeklyGoal`.
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

/** The outreach goal a stored row describes: per channel when it has channels. */
export function outreachGoalOf(
  goal: Pick<WeeklyGoal, "reachouts" | "emails" | "connectionRequests">,
): OutreachGoal {
  if (goal.emails !== undefined && goal.connectionRequests !== undefined) {
    return {
      kind: "channels",
      emails: goal.emails,
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
