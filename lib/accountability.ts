import OpenAI from "openai";
import { getOptionalEnv } from "@/lib/env";
import { fetchCortalActivity } from "@/lib/github";
import {
  appendNudgeMessage,
  getLedgerEntries,
  getSettings,
  latestSnapshot,
  setLedgerEntry,
  setNudgeState
} from "@/lib/store";
import { sendTelegram } from "@/lib/telegram";
import { appTimeZone, localDayKey } from "@/lib/time";
import type { NudgeState } from "@/lib/types";

// Outreach checkpoints: by each local wall-clock time you should have logged at
// least `target` reachouts, else a nudge fires once. Single source of the pace
// ladder (tune here, nowhere else).
export const CHECKPOINTS = [
  { at: "10:30", target: 10 },
  { at: "13:30", target: 20 },
  { at: "15:30", target: 30 },
  { at: "20:00", target: 36 }
] as const;

const AWAY_GRACE_MIN = 20; // off-camera this long with no commit -> "wandered off"
const COMMIT_SUPPRESS_MIN = 30; // a commit newer than this silences the away nudge
const AWAY_RENUDGE_MIN = 30; // min gap between repeat away nudges
const START_HOUR = 8; // working day starts; nothing fires before this
const START_GRACE_MIN = 10; // minutes past 8am before the "get to your desk" nudge
const PRESENCE_FRESH_MIN = 10; // a capture older than this can't prove present/away
export const MAX_SNOOZE_MIN = 240; // hard cap on a single granted mute (4h)

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SNOOZE_MODEL = "mistralai/mistral-small-24b-instruct-2501"; // eval winner (8/8, cheapest >=0.9); override via SNOOZE_MODEL

export type SnoozeVerdict = { action: "grant" | "challenge"; minutes: number; message: string };

export const SNOOZE_SYSTEM_PROMPT =
  "You gate mute requests for a work-accountability bot; the user is trying to pause nudges. " +
  'Reply ONLY JSON {"action":"grant"|"challenge","minutes":<int 0-240>,"message":"<short reply to send>"}. ' +
  'GRANT a realistic pause for a plausible activity at this time (lunch~30, gym~90, jiu jitsu/jj~120, errand~20; honor an explicit duration like "2h"). ' +
  "CHALLENGE with minutes:0 and a brief skeptical push-back when ANY of these hold: " +
  "(1) the activity does not fit the clock — a meal outside its window is implausible: lunch fits ~11:00-14:00, breakfast ~06:00-10:00, dinner ~17:00-21:00, so e.g. \"lunch\" at 15:00 MUST be challenged; " +
  "(2) the message is vague or unparseable (e.g. random letters, no real activity); " +
  "(3) they have already been muted a lot today (roughly 180+ minutes). Never exceed 240.";

// Fail-open verdict: an interpreter outage must never trap the user in nagging,
// so a model/network/parse failure grants a short, safe mute instead.
export const SNOOZE_FALLBACK: SnoozeVerdict = { action: "grant", minutes: 30, message: "🔕 Muted 30m." };

export function snoozeUserPrompt(ctx: { localTime: string; snoozeMinutesToday: number }, text: string): string {
  return `Local time ${ctx.localTime}. Muted so far today: ${ctx.snoozeMinutesToday} min. Message: "${text}"`;
}

// Parse a model reply into a verdict, tolerating code fences or stray prose.
// Clamps grant minutes to 0..MAX_SNOOZE_MIN, forces challenge minutes to 0, and
// coerces an unknown action to "challenge". Throws only when there is no JSON
// object at all — interpretSnooze turns that into the fail-open grant.
export function parseSnoozeVerdict(content: string | null | undefined): SnoozeVerdict {
  if (!content || content.trim().length === 0) {
    throw new Error("snooze interpreter returned no content");
  }
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("snooze interpreter returned no JSON object");
  }
  const parsed = JSON.parse(body.slice(start, end + 1)) as { action?: unknown; minutes?: unknown; message?: unknown };
  const action: SnoozeVerdict["action"] = parsed.action === "grant" ? "grant" : "challenge";
  const rawMinutes = Number(parsed.minutes);
  const minutes =
    action === "challenge" ? 0 : Math.max(0, Math.min(MAX_SNOOZE_MIN, Number.isFinite(rawMinutes) ? Math.round(rawMinutes) : 0));
  const message =
    typeof parsed.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : action === "grant"
        ? `🔕 Muted ${minutes}m.`
        : "🤨 Really — what's actually going on?";
  return { action, minutes, message };
}

export function snoozeModel(): string {
  return getOptionalEnv("SNOOZE_MODEL") || DEFAULT_SNOOZE_MODEL;
}

// OpenRouter-backed OpenAI-compatible client for the interpreter. Same base URL,
// key fallbacks, and attribution headers as the vision path. Throws when no key
// is configured so interpretSnooze can fail open.
export function snoozeClient(): OpenAI {
  const apiKey = getOptionalEnv("OPENROUTER_API_KEY") || getOptionalEnv("OPENROUTER_KEY");
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY or OPENROUTER_KEY");
  }
  return new OpenAI({
    apiKey,
    baseURL: getOptionalEnv("WORK_LIVE_OPENROUTER_BASE_URL") || DEFAULT_OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": getOptionalEnv("WORK_LIVE_PUBLIC_URL") || "https://tally-focus.vercel.app",
      "X-Title": "work-live"
    },
    maxRetries: 0
  });
}

/**
 * One raw interpreter call, shared by production `interpretSnooze` and the model
 * eval so both exercise the identical prompt, request, and parse. Returns the
 * parsed verdict plus token usage (for the eval's cost estimate). Throws on
 * network/parse errors — `interpretSnooze` wraps this to fail open.
 */
export async function runSnoozeCompletion(
  openai: OpenAI,
  model: string,
  text: string,
  ctx: { localTime: string; snoozeMinutesToday: number }
): Promise<{ verdict: SnoozeVerdict; promptTokens: number | null; completionTokens: number | null }> {
  const completion = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SNOOZE_SYSTEM_PROMPT },
      { role: "user", content: snoozeUserPrompt(ctx, text) }
    ],
    max_tokens: 200,
    temperature: 0
  });
  return {
    verdict: parseSnoozeVerdict(completion.choices[0]?.message?.content),
    promptTokens: completion.usage?.prompt_tokens ?? null,
    completionTokens: completion.usage?.completion_tokens ?? null
  };
}

/**
 * Judges one owner reply to a nudge: grant a plausible mute (with minutes) or
 * challenge an implausible/vague/over-used one (no mute). Fails OPEN — any
 * model, network, or parse error returns SNOOZE_FALLBACK (a short grant) so an
 * interpreter outage never traps the user in nagging.
 */
export async function interpretSnooze(
  text: string,
  ctx: { localTime: string; snoozeMinutesToday: number },
  model: string = snoozeModel()
): Promise<SnoozeVerdict> {
  try {
    return (await runSnoozeCompletion(snoozeClient(), model, text, ctx)).verdict;
  } catch (error) {
    console.warn("[work-live] snooze interpreter failed, granting fallback:", (error as Error).message);
    return SNOOZE_FALLBACK;
  }
}

function localParts(now: Date): { today: string; hh: number; mm: number } {
  const timeZone = appTimeZone();
  const today = localDayKey(now, timeZone);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const hh = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const mm = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { today, hh, mm };
}

// "HH:MM" local wall-clock — the context the interpreter needs to judge whether
// an excuse is plausible for the time of day.
export function localClock(now: Date = new Date()): string {
  const { hh, mm } = localParts(now);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function hmToMinutes(hm: string): number {
  const [hh, mm] = hm.split(":").map(Number);
  return hh * 60 + mm;
}

function freshNudgeState(day: string): NudgeState {
  return { day, sent8am: false, lastPresentAt: null, lastAwayNudgeAt: null, checkpointsSent: {}, snoozeMinutesToday: 0 };
}

// Today's nudge state, or a fresh one when it is missing or from a prior day.
// Shared by the cron sweep and the reply webhook so mute-minute accounting and
// per-nudge idempotence use one definition.
export function currentNudgeState(state: NudgeState | null, now: Date = new Date()): NudgeState {
  const { today } = localParts(now);
  return state && state.day === today ? state : freshNudgeState(today);
}

/**
 * The server accountability sweep, run every ~5 minutes by an external cron.
 * Idempotent: per-day `NudgeState` (persisted on the settings row) guarantees
 * each nudge fires at most once until its condition resets, so repeated calls in
 * the same window never double-buzz. Silent while paused, snoozed, or before 8am.
 * Also refreshes today's commit/merge counts from GitHub (non-fatal on failure).
 * `now` is injectable for tests.
 */
export async function evaluateAndNudge(now: Date = new Date()): Promise<void> {
  const settings = await getSettings();
  if (settings.paused) {
    return;
  }
  if (settings.snoozeUntil && now.getTime() < new Date(settings.snoozeUntil).getTime()) {
    return;
  }

  const { today, hh, mm } = localParts(now);
  if (hh < START_HOUR) {
    return;
  }
  const minutesOfDay = hh * 60 + mm;

  const state = currentNudgeState(settings.nudgeState, now);

  const latest = await latestSnapshot();
  const fresh = latest !== null && now.getTime() - new Date(latest.capturedAt).getTime() <= PRESENCE_FRESH_MIN * 60000;
  const presentNow = fresh && latest !== null && (latest.status === "present" || latest.status === "locked_in");
  if (presentNow) {
    state.lastPresentAt = now.toISOString();
  }

  // Build activity is auto-filled from GitHub; a fetch failure must not abort the
  // whole sweep, so it degrades to "no recent commit" (away nudge not suppressed).
  let lastCommitAt: string | null = null;
  try {
    const activity = await fetchCortalActivity(today);
    await setLedgerEntry(today, { commits: activity.commits, merges: activity.merges });
    lastCommitAt = activity.commits > 0 ? activity.lastCommitAt : null;
  } catch (error) {
    console.warn("[work-live] GitHub activity fetch failed:", (error as Error).message);
  }

  const reachouts = (await getLedgerEntries(today, today))[0]?.reachouts ?? 0;

  // Fire a nudge: send + log, marking sent only when BOTH succeed so a transient
  // Telegram failure re-fires next cycle instead of being silently dropped.
  const fire = async (kind: string, text: string): Promise<boolean> => {
    try {
      await sendTelegram(text);
      await appendNudgeMessage({ direction: "out", kind, text });
      return true;
    } catch (error) {
      console.warn(`[work-live] nudge send failed (${kind}):`, (error as Error).message);
      return false;
    }
  };

  // 8am: past 8:10 and no fresh presence seen yet today.
  if (minutesOfDay >= START_HOUR * 60 + START_GRACE_MIN && state.lastPresentAt === null && !state.sent8am) {
    if (await fire("8am", "🌅 Past 8am — get to your desk.")) {
      state.sent8am = true;
    }
  }

  // Wandered off: off-camera past the grace window, no recent commit, throttled.
  if (fresh && state.lastPresentAt) {
    const awayMs = now.getTime() - new Date(state.lastPresentAt).getTime();
    const commitClear = lastCommitAt === null || now.getTime() - new Date(lastCommitAt).getTime() >= COMMIT_SUPPRESS_MIN * 60000;
    const renudgeClear = now.getTime() - (state.lastAwayNudgeAt ? new Date(state.lastAwayNudgeAt).getTime() : 0) >= AWAY_RENUDGE_MIN * 60000;
    if (awayMs >= AWAY_GRACE_MIN * 60000 && commitClear && renudgeClear) {
      const mins = Math.round(awayMs / 60000);
      if (await fire("away", `👀 Away ${mins}m, no commits — wyd?`)) {
        state.lastAwayNudgeAt = now.toISOString();
      }
    }
  }

  // Outreach checkpoints: behind the pace target at this time, once each.
  for (const checkpoint of CHECKPOINTS) {
    if (minutesOfDay >= hmToMinutes(checkpoint.at) && reachouts < checkpoint.target && !state.checkpointsSent[checkpoint.at]) {
      const remaining = checkpoint.target - reachouts;
      if (await fire("checkpoint", `📤 Outreach ${reachouts}/${checkpoint.target} by ${checkpoint.at} — send ${remaining}.`)) {
        state.checkpointsSent[checkpoint.at] = true;
      }
    }
  }

  await setNudgeState(state);
}
