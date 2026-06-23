export const postureValues = ["upright", "slouched", "unknown"] as const;
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
    frameHash?: string | null; // dHash for change detection; null on legacy rows
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

export type Settings = {
  paused: boolean;
  blur: boolean;
  updatedAt: string;
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
  last30: AverageWindow;
};
