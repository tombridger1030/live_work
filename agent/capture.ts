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
  const response = await fetch(appUrl("/api/status"), {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`/api/status returned ${response.status}`);
  }
  return (await response.json()) as StatusResponse;
}

async function postFrame(frame: Uint8Array): Promise<void> {
  const frameBuffer = new ArrayBuffer(frame.byteLength);
  new Uint8Array(frameBuffer).set(frame);

  const form = new FormData();
  form.set("frame", new Blob([frameBuffer], { type: "image/jpeg" }), "frame.jpg");

  const response = await fetch(appUrl("/api/browser-capture"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OWNER_SECRET")}`
    },
    body: form
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/api/browser-capture returned ${response.status}: ${body}`);
  }
  console.log(body);
}

async function postAbsent(): Promise<void> {
  const response = await fetch(appUrl("/api/absent"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OWNER_SECRET")}`
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/api/absent returned ${response.status}: ${body}`);
  }
  console.log(body);
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
 *   when the server is paused, inside the overnight quiet window, or this tick
 *   is skipped by AFK backoff, so the launcher never opens the camera then.
 * - `post <framePath>`: posts an already-captured JPEG to `/api/browser-capture`
 *   (which stores it and rolls up the current hour). Preconditions:
 *   `WORK_LIVE_BASE_URL` and `OWNER_SECRET`.
 * - `absent`: records an "away" (score 0) snapshot via `/api/absent` when the
 *   camera could not be opened (e.g. the external webcam is unplugged), so the
 *   timeline stays continuous. Preconditions: `WORK_LIVE_BASE_URL`, `OWNER_SECRET`.
 */
async function main(): Promise<void> {
  const [command, frameArg] = process.argv.slice(2);

  if (command === "precheck") {
    const state = await status();
    if (state.paused || state.quiet || state.capture?.due === false) {
      let reason: string;
      if (state.paused) {
        reason = "paused";
      } else if (state.quiet) {
        reason = "quiet hours";
      } else {
        reason = `AFK backoff; next capture due at ${state.capture?.nextDueAt ?? "the next due tick"}`;
      }
      console.log(`${reason}; camera not opened`);
      process.exit(NO_CAPTURE_EXIT_CODE);
    }
    return;
  }

  if (command === "post") {
    if (!frameArg) {
      throw new Error("post requires a frame path");
    }
    await postFrame(new Uint8Array(await readFile(frameArg)));
    return;
  }

  if (command === "absent") {
    await postAbsent();
    return;
  }

  throw new Error(`Unknown command: ${command ?? "(none)"}. Use "precheck", "post <framePath>", or "absent".`);
}

await main();
