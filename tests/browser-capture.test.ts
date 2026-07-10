import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import jpeg from "jpeg-js";
import sharp from "sharp";
import { POST } from "@/app/api/browser-capture/route";
import { hourlyForDay, latestSnapshot, saveSnapshot, snapshotsSince } from "@/lib/store";
import { localDayKey } from "@/lib/time";
import type { Signals, SnapshotRow } from "@/lib/types";

const ownerSecret = "test-owner-secret";
const fixture = JSON.stringify({
  present: true,
  headphones: true,
  eyesOnScreen: true,
  posture: "upright",
  note: "Fixture check-in saved.",
});
let requestId = 0;


function testJpeg(): Uint8Array {
  const width = 2;
  const height = 2;
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 32;
    data[index + 1] = 96;
    data[index + 2] = 160;
    data[index + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 90).data;
}
async function solidJpeg(r: number, g: number, b: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width: 256, height: 192, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(buffer);
}

async function saveStoredSnapshot(capturedAt: Date, status: SnapshotRow["status"]): Promise<void> {
  const present = status !== "away";
  const signals: Signals = {
    present,
    headphones: present,
    eyesOnScreen: present,
    posture: present ? "upright" : "unknown",
    note: present ? "working" : "away"
  };
  await saveSnapshot({
    capturedAt,
    signals,
    score: { score: present ? 100 : 0, status },
    thumbnail: testJpeg()
  });
}

function frameRequest(
  secret: string | null,
  frame: Uint8Array | null,
  options: { proofFrame?: Uint8Array | null; source?: "agent" | "browser" } = {},
): Request {
  const form = new FormData();
  if (options.source) {
    form.set("source", options.source);
  }
  if (frame) {
    const buffer = new ArrayBuffer(frame.byteLength);
    new Uint8Array(buffer).set(frame);
    form.set("frame", new Blob([buffer], { type: "image/jpeg" }), "frame.jpg");
  }
  if (options.proofFrame) {
    const buffer = new ArrayBuffer(options.proofFrame.byteLength);
    new Uint8Array(buffer).set(options.proofFrame);
    form.set("proofFrame", new Blob([buffer], { type: "image/jpeg" }), "proof-frame.jpg");
  }

  const headers = new Headers({ "x-forwarded-for": `test-${requestId}` });
  requestId += 1;
  if (secret) {
    headers.set("Authorization", `Bearer ${secret}`);
  }
  return new Request("http://localhost/api/browser-capture", {
    method: "POST",
    headers,
    body: form,
  });
}

afterEach(async () => {
  delete process.env.OWNER_SECRET;
  delete process.env.WORK_LIVE_VISION_FIXTURE;
  delete process.env.WORK_LIVE_ALLOW_FIXTURE;
  if (existsSync(path.join(process.cwd(), ".work-live"))) {
    await rm(path.join(process.cwd(), ".work-live"), {
      force: true,
      recursive: true,
    });
  }
});

test("browser capture requires the owner secret", async () => {
  process.env.OWNER_SECRET = ownerSecret;

  const response = await POST(frameRequest(null, testJpeg()));

  expect(response.status).toBe(401);
});

test("browser capture rejects missing frames", async () => {
  process.env.OWNER_SECRET = ownerSecret;

  const response = await POST(frameRequest(ownerSecret, null));

  expect(response.status).toBe(400);
});

test("browser capture saves a snapshot through the vision fixture", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  process.env.WORK_LIVE_VISION_FIXTURE = fixture;
  process.env.WORK_LIVE_ALLOW_FIXTURE = "1";

  const response = await POST(frameRequest(ownerSecret, testJpeg()));
  const body = (await response.json()) as {
    stored: boolean;
    checkin: { avgScore: number; presentPct: number };
    score: number;
    status: string;
  };
  const latest = await latestSnapshot();
  const checkins = await hourlyForDay(localDayKey(new Date()));

  expect(response.status).toBe(200);
  expect(body.stored).toBe(true);
  expect(body.score).toBe(100);
  expect(body.status).toBe("locked_in");
  expect(body.checkin.avgScore).toBe(100);
  expect(body.checkin.presentPct).toBe(100);
  expect(latest?.score).toBe(100);
  expect(latest?.note).toBe("Fixture check-in saved.");
  expect(checkins).toHaveLength(1);
});

test("agent capture rejects identical liveness proof before vision can mark present", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  process.env.WORK_LIVE_VISION_FIXTURE = fixture;
  process.env.WORK_LIVE_ALLOW_FIXTURE = "1";
  const frame = await solidJpeg(80, 80, 80);

  const response = await POST(frameRequest(ownerSecret, frame, { source: "agent", proofFrame: frame }));
  const body = (await response.json()) as { stored: boolean; score: number; status: string; livenessStatus: string };
  const latest = await latestSnapshot();

  expect(response.status).toBe(200);
  expect(body.stored).toBe(true);
  expect(body.score).toBe(0);
  expect(body.status).toBe("away");
  expect(body.livenessStatus).toBe("stale");
  expect(latest?.captureSource).toBe("agent");
  expect(latest?.livenessStatus).toBe("stale");
  expect(latest?.note).toContain("identical decoded frames");
});

test("agent capture stores fresh liveness proof metadata", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  process.env.WORK_LIVE_VISION_FIXTURE = fixture;
  process.env.WORK_LIVE_ALLOW_FIXTURE = "1";

  const response = await POST(
    frameRequest(ownerSecret, await solidJpeg(80, 80, 80), {
      source: "agent",
      proofFrame: await solidJpeg(120, 80, 80)
    })
  );
  const body = (await response.json()) as { stored: boolean; score: number; status: string; livenessStatus: string };
  const latest = await latestSnapshot();

  expect(response.status).toBe(200);
  expect(body.stored).toBe(true);
  expect(body.score).toBe(100);
  expect(body.status).toBe("locked_in");
  expect(body.livenessStatus).toBe("fresh");
  expect(latest?.captureSource).toBe("agent");
  expect(latest?.livenessStatus).toBe("fresh");
  expect(latest?.frameSignature).toHaveLength(64);
  expect(latest?.proofSignature).toHaveLength(64);
  expect(latest?.frameSignature).not.toBe(latest?.proofSignature);
});

test("browser capture suppresses redundant away rows during AFK backoff", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  const firstAway = new Date(Date.now() - 65 * 60_000);
  const latestAway = new Date(Date.now() - 5 * 60_000);
  await saveStoredSnapshot(firstAway, "away");
  await saveStoredSnapshot(latestAway, "away");

  const response = await POST(frameRequest(ownerSecret, await solidJpeg(90, 90, 110)));
  const body = (await response.json()) as { stored: boolean; score: number; status: string };

  expect(response.status).toBe(200);
  expect(body).toEqual({ stored: false, score: 0, status: "away" });
  expect((await latestSnapshot())?.capturedAt).toBe(latestAway.toISOString());
  expect(await snapshotsSince(new Date(Date.now() - 2 * 60 * 60_000))).toHaveLength(2);
  expect(await hourlyForDay(localDayKey(new Date()))).toHaveLength(0);
});

test("browser capture stores a return immediately during AFK backoff", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  process.env.WORK_LIVE_VISION_FIXTURE = fixture;
  process.env.WORK_LIVE_ALLOW_FIXTURE = "1";
  await saveStoredSnapshot(new Date(Date.now() - 65 * 60_000), "away");
  await saveStoredSnapshot(new Date(Date.now() - 5 * 60_000), "away");

  const response = await POST(frameRequest(ownerSecret, testJpeg()));
  const body = (await response.json()) as {
    stored: boolean;
    checkin: { avgScore: number; presentPct: number };
    score: number;
    status: string;
  };
  const latest = await latestSnapshot();

  expect(response.status).toBe(200);
  expect(body.stored).toBe(true);
  expect(body.score).toBe(100);
  expect(body.status).toBe("locked_in");
  expect(body.checkin.avgScore).toBeGreaterThan(0);
  expect(body.checkin.presentPct).toBeGreaterThan(0);
  expect(latest?.status).toBe("locked_in");
  expect(latest?.note).toBe("Fixture check-in saved.");
});

const faceFixture = new Uint8Array(readFileSync(new URL("./fixtures/face.jpg", import.meta.url)));

test("browser capture returns conservative fallback when VLM provider unavailable", async () => {
  process.env.OWNER_SECRET = ownerSecret;

  // Save and temporarily unset all VLM provider credentials to simulate failure.
  const prevDashScope = process.env.DASHSCOPE_API_KEY;
  const prevQwen = process.env.QWEN_API_KEY;
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  const prevOpenRouterKey = process.env.OPENROUTER_KEY;
  const prevFixture = process.env.WORK_LIVE_VISION_FIXTURE;

  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.QWEN_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  delete process.env.WORK_LIVE_VISION_FIXTURE; // Force real detector path

  try {
    const response = await POST(frameRequest(ownerSecret, faceFixture));
    const body = (await response.json()) as {
      stored: boolean;
      checkin: { avgScore: number; presentPct: number };
      score: number;
      status: string;
      visionProvider: string | null;
    };
    const latest = await latestSnapshot();

    // Local presence succeeds, VLM unavailable, conservative fallback applied
    expect(response.status).toBe(200);
    expect(body.stored).toBe(true);
    expect(body.status).toBe("present");
    expect(body.score).toBe(30);
    expect(body.visionProvider).toBeNull();
    expect(latest?.note).toBe("Vision unavailable; presence verified locally.");
  } finally {
    // Restore env vars to avoid polluting other tests.
    if (prevDashScope !== undefined) {
      process.env.DASHSCOPE_API_KEY = prevDashScope;
    }
    if (prevQwen !== undefined) {
      process.env.QWEN_API_KEY = prevQwen;
    }
    if (prevOpenRouter !== undefined) {
      process.env.OPENROUTER_API_KEY = prevOpenRouter;
    }
    if (prevOpenRouterKey !== undefined) {
      process.env.OPENROUTER_KEY = prevOpenRouterKey;
    }
    if (prevFixture !== undefined) {
      process.env.WORK_LIVE_VISION_FIXTURE = prevFixture;
    }
  }
});
