import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import jpeg from "jpeg-js";
import { POST } from "@/app/api/browser-capture/route";
import { hourlyForDay, latestSnapshot } from "@/lib/store";
import { localDayKey } from "@/lib/time";

const ownerSecret = "test-owner-secret";
const fixture = JSON.stringify({
  present: true,
  headphones: true,
  eyesOnScreen: true,
  posture: "upright",
  note: "Fixture check-in saved.",
});

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

function frameRequest(
  secret: string | null,
  frame: Uint8Array | null,
): Request {
  const form = new FormData();
  if (frame) {
    const buffer = new ArrayBuffer(frame.byteLength);
    new Uint8Array(buffer).set(frame);
    form.set("frame", new Blob([buffer], { type: "image/jpeg" }), "frame.jpg");
  }

  return new Request("http://localhost/api/browser-capture", {
    method: "POST",
    headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
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
    checkin: { avgScore: number; presentPct: number };
    score: number;
    status: string;
  };
  const latest = await latestSnapshot();
  const checkins = await hourlyForDay(localDayKey(new Date()));

  expect(response.status).toBe(200);
  expect(body.score).toBe(100);
  expect(body.status).toBe("locked_in");
  expect(body.checkin.avgScore).toBe(100);
  expect(body.checkin.presentPct).toBe(100);
  expect(latest?.score).toBe(100);
  expect(latest?.note).toBe("Fixture check-in saved.");
  expect(checkins).toHaveLength(1);
});
