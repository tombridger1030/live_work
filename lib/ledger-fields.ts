// The single list of counts the owner logs by hand on a ledger day. The route,
// the Blob overlay, the store, the mirror, and the day report all iterate this
// list, so adding a count is one edit here. Client-safe: no server imports.

/** Counts logged before outreach was split by channel. History only. */
export const UNSPLIT_COUNT_FIELDS = [
  "reachouts",
  "replies",
  "meetings",
  "followUpsSent",
] as const;

// `...Replies` are replies received from prospects; `...RepliesAnswered` are
// the owner's answers to them.
export const EMAIL_COUNT_FIELDS = [
  "emailsSent",
  "emailFollowUps",
  "emailReplies",
  "emailRepliesAnswered",
  "emailMeetings",
] as const;

// `connections` predates the split but was always LinkedIn acceptances, so it
// keeps its storage key and reads as "accepted".
export const LINKEDIN_COUNT_FIELDS = [
  "connectionRequests",
  "connections",
  "linkedinMessages",
  "linkedinReplies",
  "linkedinRepliesAnswered",
  "linkedinMeetings",
] as const;

// Work the camera cannot see, in whole minutes so it fits the count contract
// (1000 minutes is about 16.7 hours). Credited at a discount: see
// `creditedHours` in lib/ledger.ts.
export const TIME_COUNT_FIELDS = ["awayMinutes"] as const;

export const MANUAL_COUNT_FIELDS = [
  ...UNSPLIT_COUNT_FIELDS,
  ...EMAIL_COUNT_FIELDS,
  ...LINKEDIN_COUNT_FIELDS,
  ...TIME_COUNT_FIELDS,
] as const;

export type ManualCountField = (typeof MANUAL_COUNT_FIELDS)[number];
export type ManualCounts = Record<ManualCountField, number>;

/** Counts that only exist once outreach is logged per channel. */
export const SPLIT_COUNT_FIELDS: readonly ManualCountField[] = [
  ...EMAIL_COUNT_FIELDS,
  ...LINKEDIN_COUNT_FIELDS,
].filter((field) => field !== "connections");

export const MAX_DAILY_COUNT = 1000;

export function isManualCountField(field: string): field is ManualCountField {
  return (MANUAL_COUNT_FIELDS as readonly string[]).includes(field);
}

/** A loggable daily count: a whole number from 0 to 1000. */
export function isDailyCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DAILY_COUNT
  );
}

/** Clamps free-form input (steppers, typed text) to a loggable daily count. */
export function clampDailyCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(MAX_DAILY_COUNT, Math.max(0, Math.round(value)));
}

/**
 * Reads every manual count from a stored row. Rows saved before a field existed
 * lack its key, and a missing key means nothing was logged, so it reads as 0.
 */
export function readManualCounts(
  source: Partial<Record<ManualCountField, number>>,
): ManualCounts {
  const counts = {} as ManualCounts;
  for (const field of MANUAL_COUNT_FIELDS) {
    counts[field] = source[field] ?? 0;
  }
  return counts;
}

/** New-prospect touches: what the weekly outreach goal counts. Follow-ups never do. */
export function newTouches(
  counts: Pick<ManualCounts, "reachouts" | "emailsSent" | "connectionRequests">,
): number {
  return counts.reachouts + counts.emailsSent + counts.connectionRequests;
}
