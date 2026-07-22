import { isMondayWeekStart } from "@/lib/time";

export const WEEKLY_GOAL_MIN_REACHOUTS = 1;
export const WEEKLY_GOAL_MAX_REACHOUTS = 10000;
export const WEEKLY_GOAL_MIN_HOURS = 0.1;
export const WEEKLY_GOAL_MAX_HOURS = 168;

export type WeeklyGoalValidation = { ok: true } | { ok: false; error: string };

/**
 * Validates the public weekly-goal contract once for route, store, and UI use.
 * A goal is effective-dated by a real Monday key, with whole-number messages
 * and finite hours inside the supported working range.
 */
export function validateWeeklyGoal(weekStart: unknown, reachouts: unknown, hours: unknown): WeeklyGoalValidation {
  if (typeof weekStart !== "string" || !isMondayWeekStart(weekStart)) {
    return { ok: false, error: "weekStart must be a real Monday YYYY-MM-DD" };
  }
  if (typeof reachouts !== "number" || !Number.isInteger(reachouts) || reachouts < WEEKLY_GOAL_MIN_REACHOUTS || reachouts > WEEKLY_GOAL_MAX_REACHOUTS) {
    return { ok: false, error: `weeklyReachouts must be an integer from ${WEEKLY_GOAL_MIN_REACHOUTS} to ${WEEKLY_GOAL_MAX_REACHOUTS}` };
  }
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < WEEKLY_GOAL_MIN_HOURS || hours > WEEKLY_GOAL_MAX_HOURS) {
    return { ok: false, error: `weeklyHours must be a number from ${WEEKLY_GOAL_MIN_HOURS} to ${WEEKLY_GOAL_MAX_HOURS}` };
  }
  return { ok: true };
}
