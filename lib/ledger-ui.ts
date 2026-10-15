import { newTouches } from "@/lib/ledger-fields";
import type { DaySends, LedgerDay, SendProgress } from "@/lib/ledger";
import { outreachGoalUnit, type OutreachGoal } from "@/lib/outreach-pace";

export type ProgressState = "behind" | "on pace" | "done";

export function progressState(value: number, target: number): ProgressState {
  if (target <= 0) {
    return "done";
  }
  const progress = value / target;
  if (progress >= 1) {
    return "done";
  }
  if (progress >= 0.7) {
    return "on pace";
  }
  return "behind";
}

// Tailwind tone for a progress state, shared by the Ledger board and the day
// report so "done / on pace / behind" always reads in the same color.
export function statusTone(state: ProgressState): string {
  switch (state) {
    case "done":
      return "text-emerald-300";
    case "on pace":
      return "text-amber-300";
    default:
      return "text-zinc-500";
  }
}

/**
 * Formats the Daily Trend's unique `YYYY-MM-DD` axis category as a compact day
 * number. The chart must keep the full date as its coordinate key; using this
 * displayed value as the key makes Jul 4 and Aug 4 resolve to the same point.
 */
export function ledgerChartDayTick(day: string): string {
  return String(Number(day.slice(-2)));
}

export function ledgerDayAriaLabel(day: LedgerDay): string {
  if (day.state === "future") {
    return `${day.weekdayLabel} ${day.label}, future day`;
  }

  if (day.dailyValue === null) {
    return `${day.weekdayLabel} ${day.label}: weekend, ${day.creditedHours.toFixed(1)} extra hours, ${newTouches(day)} touches`;
  }

  return `${day.weekdayLabel} ${day.label}: ${day.dailyValue} activity points, ${newTouches(day)} touches, ${day.creditedHours.toFixed(1)} hours`;
}

// The owner's names for the sends after a request (decision 2026-10-14).
export const TOUCH_LABELS = {
  firstTouches: "1st touches", // first LinkedIn messages
  secondTouches: "2nd touches", // LinkedIn follow-ups
} as const;

/**
 * A weekday's sends in display order, named the way the owner names them:
 * new outreach by its bar's unit ("Requests" or "Emails + requests"), then
 * 1st touches, 2nd touches, and "Replies". A day before the channel split
 * (a combined "touches" bar) tracked only new touches, so it shows just
 * "Touches".
 *
 * @param outreachBar the day's own outreach bar (`targets.outreach`)
 */
export function sendLines(
  sends: DaySends,
  outreachBar: OutreachGoal,
): { label: string; progress: SendProgress }[] {
  const unit = outreachGoalUnit(outreachBar);
  const outreach = {
    label: unit.charAt(0).toUpperCase() + unit.slice(1),
    progress: sends.outreach,
  };
  if (outreachBar.kind === "touches") {
    return [outreach];
  }
  return [
    outreach,
    { label: TOUCH_LABELS.firstTouches, progress: sends.firstTouches },
    { label: TOUCH_LABELS.secondTouches, progress: sends.secondTouches },
    { label: "Replies", progress: sends.replies },
  ];
}
