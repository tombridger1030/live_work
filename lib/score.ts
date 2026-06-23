import type { ScoreResult, Signals, SnapshotStatus } from "@/lib/types";
import { postureValues } from "@/lib/types";

// Focus weights, max 100 when present + eyes-on-screen + upright + headphones.
// Headphones is weighted as heavily as presence on purpose: the owner only wears
// them when seriously working, so a frame WITHOUT headphones can never reach the
// locked-in threshold (present + eyes + upright alone tops out at 70). Dropping
// eyes-on OR headphones pushes a frame into the mid band; dropping both lands ~40.
const rubric = {
  weights: {
    present: 30,
    eyesOnScreen: 28,
    postureUpright: 12,
    postureUnknown: 5,
    headphones: 30,
  },
  thresholds: {
    lockedIn: 80,
  },
} as const;

// Bump whenever the scoring weights OR the vision prompt change, so captures
// carry the generation they were analyzed under. New snapshots are stamped with
// this; older ones (lower/null) are what the backfill route re-analyzes.
export const RUBRIC_VERSION = 2;

function assertSignals(signals: Signals): void {
  if (
    typeof signals.present !== "boolean" ||
    typeof signals.headphones !== "boolean" ||
    typeof signals.eyesOnScreen !== "boolean" ||
    !postureValues.includes(signals.posture) ||
    typeof signals.note !== "string"
  ) {
    throw new Error("scoreFrom requires all four validated focus signals");
  }
}

function postureScore(signals: Signals): number {
  if (signals.posture === "upright") {
    return rubric.weights.postureUpright;
  }
  if (signals.posture === "unknown") {
    return rubric.weights.postureUnknown;
  }
  return 0;
}

function statusFor(score: number, signals: Signals): SnapshotStatus {
  // Presence drives "away". If the model sees a person at the desk, the page must
  // not headline "AWAY" — that would contradict the PRESENT signal shown beside
  // it. The focus score still conveys how locked-in they are (and gates
  // "locked_in"); it does not override presence. "away" means no person in frame.
  if (!signals.present) {
    return "away";
  }
  if (
    score >= rubric.thresholds.lockedIn &&
    signals.eyesOnScreen &&
    signals.posture === "upright"
  ) {
    return "locked_in";
  }
  return "present";
}

/**
 * Computes the public focus score and status from the four model signals.
 *
 * Preconditions: every `Signals` field is present and schema-valid. The caller
 * owns freshness and pause handling, so this function only scores a single
 * frame. Postconditions: the returned score is an integer from 0 to 100, and
 * status is derived from the rubric constants in this module only.
 */
export function scoreFrom(signals: Signals): ScoreResult {
  assertSignals(signals);

  // No person in frame → no focus. Eyes/posture/headphones never count without
  // presence, so an away frame scores a clean 0 (not a residual posture point).
  const score = signals.present
    ? Math.max(
        0,
        Math.min(
          100,
          Math.round(
            rubric.weights.present +
              (signals.eyesOnScreen ? rubric.weights.eyesOnScreen : 0) +
              (signals.headphones ? rubric.weights.headphones : 0) +
              postureScore(signals),
          ),
        ),
      )
    : 0;

  return {
    score,
    status: statusFor(score, signals),
  };
}
