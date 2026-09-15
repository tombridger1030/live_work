import { readFile } from "node:fs/promises";

type CaptureDecision = {
  due: boolean;
  intervalMinutes: number;
  awayMinutes: number | null;
  nextDueAt: string | null;
};

type StatusResponse = {
  paused: boolean;
  quiet: boolean;
  capture?: CaptureDecision;
};

/** Exit code that tells the zsh launcher "do not open the camera on this tick". */
const NO_CAPTURE_EXIT_CODE = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 2;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function appUrl(pathname: string): string {
  return new URL(pathname, requireEnv("WORK_LIVE_BASE_URL")).toString();
}

async function status(): Promise<StatusResponse> {
  const response = await requestWithRetry("/api/status", () => ({ cache: "no-store" }));
  if (!response.ok) {
    throw new Error(`/api/status returned ${response.status}: ${(await response.text()).slice(0, 180)}`);
  }
  return (await response.json()) as StatusResponse;
}

function retryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

async function requestWithRetry(
  pathname: string,
  initForAttempt: () => RequestInit,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(appUrl(pathname), { ...initForAttempt(), signal: controller.signal });
      if (!retryableStatus(response.status) || attempt === MAX_ATTEMPTS - 1) return response;
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS - 1) break;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  throw new Error(`${pathname} request failed: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

function frameForm(frame: Uint8Array, proofFrame: Uint8Array | null): FormData {
  const form = new FormData();
  form.set("source", "agent");
  form.set("frame", new Blob([new Uint8Array(frame)], { type: "image/jpeg" }), "frame.jpg");
  if (proofFrame) {
    form.set("proofFrame", new Blob([new Uint8Array(proofFrame)], { type: "image/jpeg" }), "proof-frame.jpg");
  }
  return form;
}

async function postFrame(
  frame: Uint8Array,
  proofFrame: Uint8Array | null,
  attemptId: string,
): Promise<void> {
  const response = await requestWithRetry("/api/browser-capture", () => ({
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OWNER_SECRET")}`,
      "X-Capture-Attempt-Id": attemptId,
    },
    body: frameForm(frame, proofFrame),
  }));
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/api/browser-capture returned ${response.status}: ${body}`);
  }
  console.log(body);
}

async function postAbsent(attemptId: string): Promise<void> {
  const response = await requestWithRetry("/api/absent", () => ({
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OWNER_SECRET")}`,
      "X-Capture-Attempt-Id": attemptId,
    },
  }));
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/api/absent returned ${response.status}: ${body}`);
  }
  console.log(body);
}

function failureClassFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|\b403\b|Unauthorized/i.test(message)) return "authentication_failed";
  if (/storage|store unavailable|read-only|permission denied|\b503\b/i.test(message)) return "storage_failed";
  if (/status returned/i.test(message)) return "status_unavailable";
  if (/\b502\b|vision|provider/i.test(message)) return "provider_failed";
  return "upload_failed";
}

async function reportFailure(failure: string, message: string): Promise<void> {
  const baseUrl = process.env.WORK_LIVE_BASE_URL;
  const secret = process.env.OWNER_SECRET;
  if (!baseUrl || !secret) return;
  try {
    await requestWithRetry("/api/capture-health", () => ({
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ failure, message: message.slice(0, 180) }),
    }));
  } catch {
    // Health reporting must never mask the primary capture failure.
  }
}

/**
 * Server-side half of one launchd capture tick. The camera capture itself does
 * NOT live here, on purpose: under launchd the macOS TCC "responsible process"
 * for any camera access is `bun` (the binary running this file), which ships a
 * hardened runtime without the `com.apple.security.device.camera` entitlement,
 * so TCC hard-denies it and refuses to even prompt. The zsh launcher
 * (`run-capture.sh`) runs `imagesnap` directly instead, making imagesnap the
 * responsible, grantable process; this file only talks to the server.
 *
 * Commands:
 * - `precheck`: exits 0 when capture should proceed, or `NO_CAPTURE_EXIT_CODE`
 *   when the server is paused or inside the overnight quiet window. AFK backoff
 *   no longer blocks the camera here; the server still probes every 5 minutes
 *   and suppresses redundant away rows only after analysis.
 * - `post <framePath> [proofFramePath]`: posts an already-captured JPEG plus a
 *   second liveness JPEG to `/api/browser-capture` (which stores it only when
 *   the result is worth a new row, then rolls the current hour). Preconditions:
 *   `WORK_LIVE_BASE_URL` and `OWNER_SECRET`.
 * - `absent`: records an "away" (score 0) snapshot via `/api/absent` when the
 *   camera could not be opened (e.g. the external webcam is disconnected —
 *   owner is gaming on PC or away from the Mac setup), so the timeline stays
 *   continuous. Preconditions: `WORK_LIVE_BASE_URL`, `OWNER_SECRET`.
 */
async function main(): Promise<void> {
  const [command, frameArg, proofFrameArg, attemptArg] = process.argv.slice(2);

  if (command === "precheck") {
    const state = await status();
    if (state.paused || state.quiet) {
      console.log(`${state.paused ? "paused" : "quiet hours"}; camera not opened`);
      process.exit(NO_CAPTURE_EXIT_CODE);
    }
    return;
  }

  if (command === "post") {
    if (!frameArg) {
      throw new Error("post requires a frame path");
    }
    await postFrame(
      new Uint8Array(await readFile(frameArg)),
      proofFrameArg ? new Uint8Array(await readFile(proofFrameArg)) : null,
      attemptArg ?? "manual-capture",
    );
    return;
  }

  if (command === "absent") {
    await postAbsent(attemptArg ?? "manual-capture");
    return;
  }

  throw new Error(`Unknown command: ${command ?? "(none)"}. Use "precheck", "post <framePath> [proofFramePath]", or "absent".`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const failure = failureClassFor(error);
  await reportFailure(failure, message);
  console.error(JSON.stringify({ level: "error", event: "capture_failed", failure, message: message.slice(0, 180) }));
  process.exitCode = 1;
}
