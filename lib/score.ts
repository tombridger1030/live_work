import type { ScoreResult, Signals, SnapshotStatus } from "@/lib/types";

// Public rubric is now binary on the owner's chosen proxy for serious work:
// presence proves they are at the desk, headphones proves they are actually
// locked in. If present without headphones, they are explicitly only 30/100.
const rubric = {
  weights: {
    present: 30,
    headphones: 70,
  },
} as const;

// Bump whenever the scoring weights, the vision prompt, OR the analysis pipeline
// change, so captures carry the generation they were analyzed under. New
// snapshots are stamped with this; older ones (lower/null) are what the backfill
// route re-analyzes. v6: long-run fail-safes force fresh/audited presence so
// stale present/away classifications cannot run for hours.
export const RUBRIC_VERSION = 6;

function assertSignals(signals: Signals): void {
  if (
    typeof signals.present !== "boolean" ||
    typeof signals.headphones !== "boolean" ||
    typeof signals.note !== "string"
  ) {
    throw new Error("scoreFrom requires validated present/headphones signals");
  }
}

function statusFor(signals: Signals): SnapshotStatus {
  if (!signals.present) {
    return "away";
  }
  if (signals.headphones) {
    return "locked_in";
  }
  return "present";
}

/**
 * Computes the public focus score and status from the owner's two chosen gates:
 * present at the desk, and wearing headphones. Away is a clean 0; present
 * without headphones is 30/100; present with headphones is locked_in at 100.
 */
export function scoreFrom(signals: Signals): ScoreResult {
  assertSignals(signals);

  const score = signals.present
    ? rubric.weights.present + (signals.headphones ? rubric.weights.headphones : 0)
    : 0;

  return {
    score,
    status: statusFor(signals),
  };
}
