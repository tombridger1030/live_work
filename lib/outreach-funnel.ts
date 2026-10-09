import { SPLIT_COUNT_FIELDS, type ManualCounts } from "@/lib/ledger-fields";
import { isOutreachDay } from "@/lib/outreach-pace";

// The outreach pipeline: per-channel conversion over a trailing window, judged
// against the owner's targets, plus the follow-ups each day owes. Pure: reads
// a contiguous, ascending run of ledger days and nothing else.

export const FUNNEL_WINDOW_DAYS = 28;
// Below this many in a step's denominator, a rate is noise, not a verdict.
export const FUNNEL_MIN_SAMPLE = 10;
export const EMAIL_FOLLOW_UP_WEEKDAYS = 3;

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

export type FollowUpsDue = { emailFollowUps: number; linkedinMessages: number };

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

/**
 * What `days[index]` owes in follow-ups: a to-do, never a goal.
 *
 * - Email: everything sent three weekdays earlier (Mon -> Thu, Wed -> Mon).
 * - LinkedIn: people who accepted (window through this day) minus first
 *   messages sent before this day, floored at 0. This day's own messages are
 *   "done", so they never shrink "due".
 *
 * Returns null on weekends and on days before the split.
 */
export function followUpsDue(
  days: FunnelDay[],
  index: number,
  splitStart: string | null,
): FollowUpsDue | null {
  const today = days[index];
  if (
    !today ||
    splitStart === null ||
    today.day < splitStart ||
    !isOutreachDay(today.day)
  ) {
    return null;
  }
  let emailFollowUps = 0;
  let weekdaysBack = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!isOutreachDay(days[cursor].day)) continue;
    weekdaysBack += 1;
    if (weekdaysBack === EMAIL_FOLLOW_UP_WEEKDAYS) {
      emailFollowUps = days[cursor].inRange ? days[cursor].emailsSent : 0;
      break;
    }
  }
  const fromDay = windowStart(splitStart, today.day);
  const accepted = sumOver(days, "connections", fromDay, today.day);
  const messagedBefore = sumOver(
    days,
    "linkedinMessages",
    fromDay,
    shiftDay(today.day, -1),
  );
  return {
    emailFollowUps,
    linkedinMessages: Math.max(0, accepted - messagedBefore),
  };
}
