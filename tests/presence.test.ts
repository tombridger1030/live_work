import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { detectPresence } from "@/lib/presence";
import { analyzeFrame } from "@/lib/vision";

// A real (synthetic GAN, no-licensing) head-and-shoulders photo — the positive
// case that guards against a "detector never sees anyone" regression.
const faceFixture = new Uint8Array(readFileSync(new URL("./fixtures/face.jpg", import.meta.url)));

async function solidJpeg(r: number, g: number, b: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width: 256, height: 192, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(buffer);
}

// Bright magenta background with a dark, featureless head blob — no real person,
// the backlit silhouette an over-eager detector might call "present".
async function purpleSilhouette(): Promise<Uint8Array> {
  const head = await sharp({ create: { width: 110, height: 120, channels: 3, background: { r: 9, g: 7, b: 13 } } })
    .png()
    .toBuffer();
  const buffer = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 155, g: 20, b: 185 } } })
    .composite([{ input: head, top: 70, left: 105 }])
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(buffer);
}

test("detects a person in a real photo", async () => {
  const result = await detectPresence(faceFixture);
  expect(result.present).toBe(true);
  expect(result.score).toBeGreaterThan(0.5);
});

test("no person in a flat empty frame", async () => {
  const result = await detectPresence(await solidJpeg(90, 90, 110));
  expect(result.present).toBe(false);
});

test("no person in a backlit silhouette / empty room", async () => {
  const result = await detectPresence(await purpleSilhouette());
  expect(result.present).toBe(false);
});

test("WORK_LIVE_PRESENCE_MIN_SCORE raises the bar so even a real person is rejected", async () => {
  const prev = process.env.WORK_LIVE_PRESENCE_MIN_SCORE;
  process.env.WORK_LIVE_PRESENCE_MIN_SCORE = "0.99";
  try {
    expect((await detectPresence(faceFixture)).present).toBe(false);
  } finally {
    if (prev === undefined) {
      delete process.env.WORK_LIVE_PRESENCE_MIN_SCORE;
    } else {
      process.env.WORK_LIVE_PRESENCE_MIN_SCORE = prev;
    }
  }
});

test("analyzeFrame reports away (no VLM call) when no person is present", async () => {
  // Deleting the canned fixture forces the real detector path, not a stub.
  const prevFixture = process.env.WORK_LIVE_VISION_FIXTURE;
  delete process.env.WORK_LIVE_VISION_FIXTURE;
  try {
    const signals = await analyzeFrame(await purpleSilhouette());
    expect(signals.present).toBe(false);
    expect(signals.eyesOnScreen).toBe(false);
    expect(signals.note).toContain("No person detected");
  } finally {
    if (prevFixture !== undefined) {
      process.env.WORK_LIVE_VISION_FIXTURE = prevFixture;
    }
  }
});
