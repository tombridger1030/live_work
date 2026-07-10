import type { LedgerDay } from "@/lib/ledger";

export type ProgressState = "behind" | "on pace" | "done";

export function clampReachouts(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1000, Math.max(0, Math.round(value)));
}

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

export function ledgerDayAriaLabel(day: LedgerDay): string {
  if (day.state === "future") {
    return `${day.weekdayLabel} ${day.label}, future day`;
  }

  return `${day.weekdayLabel} ${day.label}: ${day.dailyValue} points, ${day.reachouts} reachouts, ${day.hours.toFixed(1)} hours, ${day.featureDone ? "feature shipped" : "no feature shipped"}`;
}
