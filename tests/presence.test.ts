import { presenceMinScore } from "@/lib/presence";
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

// The accept threshold is calibrated data, not a taste call: swept on 2026-07-27
// against 73 frames the owner confirmed he was present in and 8 he confirmed were
// an empty chair. 0.5 recovered 41/73; 0.35 recovers 50/73 with the same 0/8 false
// alarms, because empty chairs score below the 0.15 model floor. The detector's
// blind spot is a downturned head in dim light — the deep-work posture — and at
// 0.5 that cost ~6.1 hours wrongly scored as away. Raising it silently would
// re-lose those frames, so the value is pinned here.
test("the default presence threshold stays at the calibrated 0.35", () => {
  const prev = process.env.WORK_LIVE_PRESENCE_MIN_SCORE;
  delete process.env.WORK_LIVE_PRESENCE_MIN_SCORE;
  try {
    expect(presenceMinScore()).toBe(0.35);
  } finally {
    if (prev !== undefined) process.env.WORK_LIVE_PRESENCE_MIN_SCORE = prev;
  }
});

// Per-camera tuning must work, but a malformed value must never silently widen or
// close the gate — it falls back to the calibrated default.
test("presence threshold honors a valid override and rejects malformed ones", () => {
  const prev = process.env.WORK_LIVE_PRESENCE_MIN_SCORE;
  try {
    process.env.WORK_LIVE_PRESENCE_MIN_SCORE = "0.6";
    expect(presenceMinScore()).toBe(0.6);

    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      process.env.WORK_LIVE_PRESENCE_MIN_SCORE = bad;
      expect(presenceMinScore()).toBe(0.35);
    }
  } finally {
    if (prev === undefined) delete process.env.WORK_LIVE_PRESENCE_MIN_SCORE;
    else process.env.WORK_LIVE_PRESENCE_MIN_SCORE = prev;
  }
});
