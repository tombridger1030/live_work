import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CaptureFailureClass,
  CaptureFreshness,
  CaptureFreshnessReason,
  CaptureHealth,
  Settings,
} from "@/lib/types";
import { isQuietNow, minutesSince } from "@/lib/time";
import { localDataRoot } from "@/lib/store";
import { captureAlertAfterMinutes } from "@/lib/capture-thresholds";

export { captureAlertAfterMinutes } from "@/lib/capture-thresholds";

const healthFileName = "capture-health.json";
const maxFailureMessageLength = 180;

function healthFile(): string {
  return path.join(localDataRoot(), healthFileName);
}

export function emptyCaptureHealth(): CaptureHealth {
  return {
    lastAttemptAt: null,
    lastImageAt: null,
    lastImageId: null,
    lastFailureAt: null,
    lastFailure: null,
    lastFailureMessage: null,
  };
}

function safeFailureMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|secret|key)=\S+/gi, "$1=[redacted]")
    .slice(0, maxFailureMessageLength);
}

async function writeHealth(health: CaptureHealth): Promise<void> {
  const target = healthFile();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

/**
 * Reads the small health record independently from the large snapshot store.
 * Corruption is returned as a storage failure rather than throwing through the
 * health route, so the monitor can report the real failure class.
 */
export async function readCaptureHealth(): Promise<CaptureHealth> {
  const target = healthFile();
  if (!existsSync(target)) return emptyCaptureHealth();
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<CaptureHealth>;
    return {
      ...emptyCaptureHealth(),
      ...parsed,
      lastFailureMessage: safeFailureMessage(parsed.lastFailureMessage),
    };
  } catch (error) {
    return {
      ...emptyCaptureHealth(),
      lastFailureAt: new Date().toISOString(),
      lastFailure: "storage_failed",
      lastFailureMessage: safeFailureMessage((error as Error).message) ?? "Health record unreadable",
    };
  }
}

/** Records that one scheduled capture tick reached the server. */
export async function recordCaptureAttempt(at = new Date()): Promise<void> {
  try {
    const health = await readCaptureHealth();
    await writeHealth({ ...health, lastAttemptAt: at.toISOString() });
  } catch (error) {
    console.error("[work-live] capture health attempt could not be recorded", (error as Error).message);
  }
}

/** Records a valid image upload, even when AFK cadence suppresses its row. */
export async function recordCaptureImage(
  id: string | null,
  capturedAt = new Date(),
): Promise<void> {
  try {
    const health = await readCaptureHealth();
    await writeHealth({
      ...health,
      lastAttemptAt: capturedAt.toISOString(),
      lastImageAt: capturedAt.toISOString(),
      lastImageId: id,
      lastFailureAt: null,
      lastFailure: null,
      lastFailureMessage: null,
    });
  } catch (error) {
    console.error("[work-live] capture health image could not be recorded", (error as Error).message);
  }
}

/** Records a bounded, secret-free failure that can be surfaced by health checks. */
export async function recordCaptureFailure(
  failure: CaptureFailureClass,
  message: string | null = null,
  at = new Date(),
): Promise<void> {
  try {
    const health = await readCaptureHealth();
    await writeHealth({
      ...health,
      lastAttemptAt: at.toISOString(),
      lastFailureAt: at.toISOString(),
      lastFailure: failure,
      lastFailureMessage: safeFailureMessage(message),
    });
  } catch (error) {
    console.error("[work-live] capture health failure could not be recorded", (error as Error).message);
  }
}

function failureReason(failure: CaptureFailureClass | null): CaptureFreshnessReason {
  switch (failure) {
    case "camera_unavailable": return "camera_unavailable";
    case "upload_failed": return "upload_failed";
    case "storage_failed": return "storage_failed";
    case "provider_failed": return "provider_failed";
    default: return "unknown_failure";
  }
}

/**
 * Computes the user-visible and alertable capture state.
 *
 * Preconditions: timestamps are ISO strings or null; settings are the current
 * capture settings. Postconditions: paused and quiet periods never alert, and
 * a fresh mirror publication cannot make an old image look fresh.
 */
export function captureFreshnessFor(
  health: CaptureHealth,
  settings: Settings,
  now = new Date(),
): CaptureFreshness {
  if (settings.paused) {
    return { expected: false, stale: false, reason: "paused", attemptAgeMinutes: null, imageAgeMinutes: null };
  }
  if (isQuietNow(now)) {
    return { expected: false, stale: false, reason: "quiet_hours", attemptAgeMinutes: null, imageAgeMinutes: null };
  }

  const attemptAgeMinutes = health.lastAttemptAt ? minutesSince(health.lastAttemptAt, now) : null;
  const imageAgeMinutes = health.lastImageAt ? minutesSince(health.lastImageAt, now) : null;
  if (attemptAgeMinutes === null) {
    return { expected: true, stale: true, reason: "no_attempt", attemptAgeMinutes, imageAgeMinutes };
  }
  if (attemptAgeMinutes > captureAlertAfterMinutes) {
    return { expected: true, stale: true, reason: "agent_stale", attemptAgeMinutes, imageAgeMinutes };
  }
  if (imageAgeMinutes === null || imageAgeMinutes > captureAlertAfterMinutes) {
    return {
      expected: true,
      stale: true,
      reason: health.lastFailure ? failureReason(health.lastFailure) : "image_stale",
      attemptAgeMinutes,
      imageAgeMinutes,
    };
  }
  return { expected: true, stale: false, reason: null, attemptAgeMinutes, imageAgeMinutes };
}

export function captureHealthFromLatest(
  latest: { id: string; capturedAt: string; captureSource?: string | null } | null,
): CaptureHealth {
  if (!latest) return emptyCaptureHealth();
  const image = latest.captureSource === "absent" ? null : latest;
  return {
    ...emptyCaptureHealth(),
    lastAttemptAt: latest.capturedAt,
    lastImageAt: image?.capturedAt ?? null,
    lastImageId: image?.id ?? null,
  };
}

/** Keeps pre-health-format mirrors useful by deriving a conservative fallback. */
export function mergeCaptureHealthWithLatest(
  health: CaptureHealth,
  latest: { id: string; capturedAt: string; captureSource?: string | null } | null,
): CaptureHealth {
  const fallback = captureHealthFromLatest(latest);
  return {
    ...health,
    lastAttemptAt: health.lastAttemptAt ?? fallback.lastAttemptAt,
    lastImageAt: health.lastImageAt ?? fallback.lastImageAt,
    lastImageId: health.lastImageId ?? fallback.lastImageId,
  };
}

export function captureFailureClassForError(error: unknown): CaptureFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|\b403\b|Unauthorized/i.test(message)) return "authentication_failed";
  if (/vision|provider|\b502\b|\b402\b/i.test(message)) return "provider_failed";
  if (/status returned|fetch failed|timed out|timeout|\b408\b|\b429\b|\b5\d\d\b/i.test(message)) {
    return "upload_failed";
  }
  if (/store|storage|JSON|EACCES|ENOENT|ENOSPC|read-only/i.test(message)) return "storage_failed";
  return "unknown";
}

export type CaptureMonitorAction =
  | { kind: "none" }
  | { kind: "failure"; key: string; ageMinutes: number | null }
  | { kind: "recovery" };

/** Makes alert deduplication a pure contract that can be tested without Telegram. */
export function captureMonitorAction(
  health: CaptureHealth,
  freshness: CaptureFreshness,
  incident: { key: string; startedAt: string } | null | undefined,
): CaptureMonitorAction {
  if (!freshness.expected) return { kind: "none" };
  const key = `${freshness.reason ?? "image_stale"}:${health.lastImageAt ?? "never"}`;
  if (freshness.stale) {
    return incident?.key === key
      ? { kind: "none" }
      : { kind: "failure", key, ageMinutes: freshness.imageAgeMinutes };
  }
  return incident ? { kind: "recovery" } : { kind: "none" };
}
