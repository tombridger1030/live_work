export const postureValues = ["upright", "slouched", "unknown"] as const;
export type CaptureSource = "agent" | "browser" | "absent";
export type LivenessStatus = "fresh" | "weak" | "stale" | "not_checked";

export type Posture = (typeof postureValues)[number];

export type SnapshotStatus = "locked_in" | "present" | "away";
export type DisplayStatus = SnapshotStatus | "paused" | "no_recent_data";

export type Signals = {
  present: boolean;
  headphones: boolean;
  eyesOnScreen: boolean;
  posture: Posture;
  note: string;
};

export type ScoreResult = {
  score: number;
  status: SnapshotStatus;
};

export type SnapshotRow = Signals &
  ScoreResult & {
    id: string;
    capturedAt: string;
    thumbUrl: string;
    frameHash?: string | null; // perceptual dHash for near-duplicate runs; null on legacy rows
    captureSource?: CaptureSource | null;
    frameSignature?: string | null; // decoded-pixel signature for exact stale-frame detection
    proofSignature?: string | null;
    livenessStatus?: LivenessStatus | null;
    livenessScore?: number | null; // mean decoded-pixel delta between frame and proof frame
  };

export type HourlyCheckin = {
  day: string;
  hour: number;
  avgScore: number;
  presentPct: number;
  headphonesPct: number;
  verdict: string;
  critical: boolean; // human-confirmed: this hour went to the most critical task
};

export type DayHistory = {
  day: string; // local day (YYYY-MM-DD)
  avgScore: number; // mean of that day's hourly avg scores, 0-100
  presentPct: number; // mean of that day's hourly presence, 0-100
  hours: number; // number of hourly check-ins recorded that day
};

// Per-day nudge bookkeeping persisted on the settings row so the 5-minute cron
// stays idempotent: which nudges already fired today, last-seen presence, and how
// many mute-minutes have been granted (for over-use pushback). Resets when `day`
// rolls over.
export type NudgeState = {
  day: string; // local day YYYY-MM-DD this state covers
  sent8am: boolean;
  lastPresentAt: string | null; // ISO of the last fresh present/locked-in capture
  lastAwayNudgeAt: string | null; // ISO of the last "wandered off" buzz
  checkpointsSent: Record<string, boolean>; // checkpoint "at" -> already nudged
  snoozeMinutesToday: number; // total granted mute minutes today
};

export type Settings = {
  paused: boolean;
  blur: boolean;
  updatedAt: string;
  snoozeUntil: string | null; // ISO; all nudges suppressed until this instant
  nudgeState: NudgeState | null; // today's nudge bookkeeping (see NudgeState)
};

export type TodayStats = {
  snapshots: number; // scoring-window snapshots captured that day
  avgScore: number; // mean focus score across the day's scoring hours (0-100)
  hoursPresent: number; // present snapshots converted to hours (1 decimal)
  headphonesPct: number; // % of scoring-window snapshots wearing headphones
  criticalHours: number; // human-confirmed scoring hours spent on the most critical task
};

// A rolling average over the last N days that had data ("present days"). Built
// from per-day metrics, so missing/non-working days never dilute it.
export type AverageWindow = {
  days: number; // present days actually averaged (<= the window size)
  avgScore: number; // mean focus score across the window's scoring hours (0-100)
  hoursPresent: number; // mean hours present per present day (1 decimal)
  headphonesPct: number; // mean of each day's headphones %
  criticalHours: number; // mean of each day's critical hours
  snapshots: number; // mean scoring-window snapshots per present day
};

export type AverageStats = {
  last7: AverageWindow;
  previous7: AverageWindow; // the 7 present days before last7, for week-over-week deltas
  last30: AverageWindow;
};

// Persisted as scoreboard_entries (Postgres) and scoreboardEntries (local JSON)
// to preserve existing manual reachout/feature data without a migration.
export type LedgerEntry = {
  day: string; // local day YYYY-MM-DD
  reachouts: number; // manual count, >= 0
  featureDone: boolean; // manual: at least one e2e-tested feature shipped that day
  replies: number; // manual: replies received that day, >= 0
  meetings: number; // manual: meetings booked that day, >= 0
  commits: number; // auto: commits to the build repo that day, >= 0
  merges: number; // auto: merged PRs to the build repo that day, >= 0
};
// Effective-dated weekly goals. A row keyed by Monday applies from that week
// forward until the next saved row; earlier weeks never inherit a later goal.
export type WeeklyGoal = {
  weekStart: string; // Monday YYYY-MM-DD
  reachouts: number; // weekly messages goal, >= 1
  hours: number; // weekly hours goal, > 0
};


// One line of the two-way nudge conversation: an outbound bot buzz ("out") or an
// inbound owner reply ("in"). `kind` tags the type (8am/away/checkpoint/reply/
// grant/challenge). Read newest-first for the ledger Nudges panel.
export type NudgeMessage = {
  id: string;
  createdAt: string; // ISO timestamp
  direction: "out" | "in";
  kind: string;
  text: string;
};
