import { SPLIT_COUNT_FIELDS, type ManualCounts } from "@/lib/ledger-fields";
import { isOutreachDay } from "@/lib/outreach-pace";

// The outreach pipeline: per-channel conversion over a trailing window, judged
// against the owner's targets, plus the follow-ups each day owes. Pure: reads
// a contiguous, ascending run of ledger days and nothing else.

export const FUNNEL_WINDOW_DAYS = 28;
// Below this many in a step's denominator, a rate is noise, not a verdict.
export const FUNNEL_MIN_SAMPLE = 10;
export const EMAIL_FOLLOW_UP_WEEKDAYS = 3;
// A LinkedIn first message with no reply earns a follow-up (a 2nd touch) this
// many weekdays after it was sent (owner decision, 2026-10-14).
export const LINKEDIN_FOLLOW_UP_WEEKDAYS = 5;

/** A ledger day as the pipeline sees it. Only in-range days carry real counts. */
export type FunnelDay = { day: string; inRange: boolean } & ManualCounts;

export type FunnelStatus = "low" | "on target" | "not enough yet" | "no target";

export type FunnelStep = {
  key: string;
  label: string;
  count: number;
  /** count / the previous step's count; null on the first step or a 0 denominator. */
  rate: number | null;
  target: { min: number; label: string } | null;
  /** null on the first step, which has nothing to convert from. */
  status: FunnelStatus | null;
};

export type OutreachFunnel = {
  /** First day counted; null until anything is logged per channel. */
  fromDay: string | null;
  toDay: string;
  linkedin: FunnelStep[];
  email: FunnelStep[];
  emailFollowUps: number;
  /** One plain-English line naming what to fix first. */
  headline: string;
};

/**
 * What a day owes, keyed by the count that clears each item: email follow-ups,
 * LinkedIn first messages (1st touches), LinkedIn follow-ups (2nd touches), and
 * answers to prospects who replied on each channel.
 */
export type DueToday = {
  emailFollowUps: number;
  linkedinMessages: number;
  linkedinFollowUps: number;
  emailRepliesAnswered: number;
  linkedinRepliesAnswered: number;
};

type StepSpec = {
  key: string;
  label: string;
  field: keyof ManualCounts;
  target: { min: number; label: string } | null;
};

const LINKEDIN_STEPS: StepSpec[] = [
  {
    key: "requests",
    label: "Requests",
    field: "connectionRequests",
    target: null,
  },
  {
    key: "accepted",
    label: "Accepted",
    field: "connections",
    target: { min: 0.3, label: "30-40%" },
  },
  {
    key: "messaged",
    label: "Messaged",
    field: "linkedinMessages",
    target: { min: 0.9, label: "90%" },
  },
  {
    key: "replied",
    label: "Replied",
    field: "linkedinReplies",
    target: { min: 0.5, label: "50%" },
  },
  {
    key: "meetings",
    label: "Meetings",
    field: "linkedinMeetings",
    target: { min: 0.5, label: "50%" },
  },
];

const EMAIL_STEPS: StepSpec[] = [
  { key: "sent", label: "Sent", field: "emailsSent", target: null },
  { key: "replied", label: "Replied", field: "emailReplies", target: null },
  { key: "meetings", label: "Meetings", field: "emailMeetings", target: null },
];

function shiftDay(day: string, days: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The first in-range day with any per-channel count: the day outreach was
 * first logged by channel. Null when it never has been. Everything before it
 * is unsplit history that no channel ratio may read.
 */
export function splitStartDay(days: FunnelDay[]): string | null {
  for (const day of days) {
    if (day.inRange && SPLIT_COUNT_FIELDS.some((field) => day[field] > 0)) {
      return day.day;
    }
  }
  return null;
}

function windowStart(splitStart: string, day: string): string {
  const trailing = shiftDay(day, -(FUNNEL_WINDOW_DAYS - 1));
  return trailing > splitStart ? trailing : splitStart;
}

function sumOver(
  days: FunnelDay[],
  field: keyof ManualCounts,
  fromDay: string,
  toDay: string,
): number {
  let total = 0;
  for (const day of days) {
    if (day.inRange && day.day >= fromDay && day.day <= toDay) {
      total += day[field];
    }
  }
  return total;
}

function buildSteps(
  specs: StepSpec[],
  days: FunnelDay[],
  fromDay: string,
  toDay: string,
): FunnelStep[] {
  const counts = specs.map((spec) => sumOver(days, spec.field, fromDay, toDay));
  return specs.map((spec, index) => {
    if (index === 0) {
      return {
        key: spec.key,
        label: spec.label,
        count: counts[0],
        rate: null,
        target: spec.target,
        status: null,
      };
    }
    const from = counts[index - 1];
    const rate = from > 0 ? counts[index] / from : null;
    let status: FunnelStatus;
    if (from < FUNNEL_MIN_SAMPLE) status = "not enough yet";
    else if (!spec.target) status = "no target";
    else status = rate !== null && rate < spec.target.min ? "low" : "on target";
    return {
      key: spec.key,
      label: spec.label,
      count: counts[index],
      rate,
      target: spec.target,
      status,
    };
  });
}

const percent = (rate: number | null) => `${Math.round((rate ?? 0) * 100)}%`;

// Funnel order matters: an unsent backlog ("messaged") is named before the
// message ("replied") is blamed for silence.
function linkedinHeadline(steps: FunnelStep[]): string {
  const low = steps.find((step) => step.status === "low");
  if (low) {
    const previous = steps[steps.indexOf(low) - 1];
    switch (low.key) {
      case "accepted":
        return `Only ${percent(low.rate)} accept your requests (target ${low.target?.label}). Check who you're sending to.`;
      case "messaged":
        return `You've messaged ${low.count} of ${previous.count} people who accepted. Send those first messages before judging replies.`;
      case "replied":
        return `${percent(low.rate)} of people you message reply (target ${low.target?.label}). Your first message isn't landing.`;
      default:
        return `${percent(low.rate)} of replies turn into meetings (target ${low.target?.label}). Make the ask clearer.`;
    }
  }
  if (steps.some((step) => step.status === "not enough yet")) {
    return "Not enough LinkedIn data yet to judge. Keep logging.";
  }
  return "LinkedIn is on target at every step.";
}

/**
 * Conversion for each channel over the last 28 days through `today`, starting
 * no earlier than the split. Each step's rate is against the step before it.
 * Precondition: `days` is ascending and contiguous.
 */
export function buildOutreachFunnel(
  days: FunnelDay[],
  today: string,
): OutreachFunnel {
  const splitStart = splitStartDay(days);
  if (splitStart === null || splitStart > today) {
    const empty = (specs: StepSpec[]) =>
      specs.map((spec, index) => ({
        key: spec.key,
        label: spec.label,
        count: 0,
        rate: null,
        target: spec.target,
        status: index === 0 ? null : ("not enough yet" as const),
      }));
    return {
      fromDay: null,
      toDay: today,
      linkedin: empty(LINKEDIN_STEPS),
      email: empty(EMAIL_STEPS),
      emailFollowUps: 0,
      headline: "Starts when you log your first email or LinkedIn request.",
    };
  }
  const fromDay = windowStart(splitStart, today);
  const linkedin = buildSteps(LINKEDIN_STEPS, days, fromDay, today);
  return {
    fromDay,
    toDay: today,
    linkedin,
    email: buildSteps(EMAIL_STEPS, days, fromDay, today),
    emailFollowUps: sumOver(days, "emailFollowUps", fromDay, today),
    headline: linkedinHeadline(linkedin),
  };
}

// The day a send's follow-up falls due: `after` weekdays after it was sent.
function followUpDay(sent: string, after: number): string {
  let day = sent;
  let weekdays = 0;
  while (weekdays < after) {
    day = shiftDay(day, 1);
    if (isOutreachDay(day)) weekdays += 1;
  }
  return day;
}

/**
 * What `days[index]` owes. Every count is a running backlog over the pipeline
 * window, so anything skipped stays due until it is done, and a weekend shows
 * what is left to catch up.
 *
 * - Email follow-ups: emails whose follow-up day (three weekdays after
 *   sending: Mon -> Thu, Wed -> Mon) has arrived, minus follow-ups sent before
 *   this day. Cannot see replies, so it can ask for an unneeded follow-up.
 * - LinkedIn first messages: people who accepted (through this day) minus first
 *   messages sent before this day.
 * - LinkedIn follow-ups: first messages whose follow-up day (five weekdays
 *   after sending: Tue Oct 6 -> Tue Oct 13) has arrived, minus LinkedIn replies
 *   received (through this day), minus follow-ups sent before this day. The
 *   counts cannot say who replied, so every reply is assumed to come from a
 *   message that is due; when one comes from a newer message or a follow-up,
 *   this asks for one too few, never one too many.
 * - Replies to answer, per channel: replies received (through this day) minus
 *   replies answered before this day.
 *
 * Floored at 0. This day's own sends are "done", so they never shrink "due".
 * Returns null before the split.
 */
export function dueToday(days: FunnelDay[], index: number, splitStart: string | null): DueToday | null {
  const today = days[index];
  if (!today || splitStart === null || today.day < splitStart) {
    return null;
  }
  const fromDay = windowStart(splitStart, today.day);
  const yesterday = shiftDay(today.day, -1);
  // Received through today, minus what was handled before today.
  const backlog = (received: keyof ManualCounts, handled: keyof ManualCounts) =>
    Math.max(0, sumOver(days, received, fromDay, today.day) - sumOver(days, handled, fromDay, yesterday));
  // Sends in the window whose follow-up day has arrived by today.
  const followUpsFallenDue = (sent: keyof ManualCounts, after: number) => {
    let total = 0;
    for (const day of days) {
      if (day.inRange && day.day >= fromDay && day.day <= today.day && followUpDay(day.day, after) <= today.day) {
        total += day[sent];
      }
    }
    return total;
  };
  return {
    emailFollowUps: Math.max(
      0,
      followUpsFallenDue("emailsSent", EMAIL_FOLLOW_UP_WEEKDAYS) - sumOver(days, "emailFollowUps", fromDay, yesterday),
    ),
    linkedinMessages: backlog("connections", "linkedinMessages"),
    linkedinFollowUps: Math.max(
      0,
      followUpsFallenDue("linkedinMessages", LINKEDIN_FOLLOW_UP_WEEKDAYS) -
        sumOver(days, "linkedinReplies", fromDay, today.day) -
        sumOver(days, "linkedinFollowUps", fromDay, yesterday),
    ),
    emailRepliesAnswered: backlog("emailReplies", "emailRepliesAnswered"),
    linkedinRepliesAnswered: backlog("linkedinReplies", "linkedinRepliesAnswered"),
  };
}
