import { expect, test } from "bun:test";
import sharp from "sharp";
import { unreadableFrameReason } from "@/lib/vision";

// Build a solid-colour JPEG of the given mean RGB to exercise the frame guard.
async function solidJpeg(r: number, g: number, b: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(buffer);
}

test("flags a dark frame as unverifiable", async () => {
  const reason = await unreadableFrameReason(await solidJpeg(8, 8, 8));
  expect(reason).toBe("Frame too dark to verify presence.");
});

test("flags a green infrared/night-vision frame", async () => {
  // Bright green, little red/blue — the 12am night-vision signature that the
  // model wrongly read as a person working.
  const reason = await unreadableFrameReason(await solidJpeg(28, 150, 28));
  expect(reason).toContain("Infrared/night-vision");
});

test("flags a dim grayscale night-vision frame", async () => {
  const reason = await unreadableFrameReason(await solidJpeg(55, 55, 55));
  expect(reason).toContain("grayscale");
});

test("passes a normally-lit colour frame through to the model", async () => {
  const reason = await unreadableFrameReason(await solidJpeg(150, 120, 105));
  expect(reason).toBeNull();
});

test("does not flag a dim frame with a brightly lit subject", async () => {
  // Low MEAN luma (dark background) but high variance (a lit face) — the
  // monitor-below-eye-level working frame the mean-only guard wrongly rejected.
  const patch = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 230, b: 200 } } })
    .png()
    .toBuffer();
  const composed = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 8, g: 8, b: 40 } } })
    .composite([{ input: patch, top: 24, left: 24 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  const reason = await unreadableFrameReason(new Uint8Array(composed));
  expect(reason).toBeNull();
});

test("does not flag a dim near-grayscale frame with a lit face", async () => {
  // The reported false-away bug: a dim room reads near-grayscale (tiny colour
  // spread) and below the brightness cutoff, but a clearly-lit face gives high
  // per-channel variance. luma 69.6 / spread 1.0 / stdev ~50 — the mean-only
  // grayscale guard wrongly gated this to "away"; the variance floor lets it
  // through to the model.
  const face = await sharp({ create: { width: 22, height: 22, channels: 3, background: { r: 220, g: 212, b: 205 } } })
    .png()
    .toBuffer();
  const composed = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 50, g: 50, b: 53 } } })
    .composite([{ input: face, top: 21, left: 21 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  const reason = await unreadableFrameReason(new Uint8Array(composed));
  expect(reason).toBeNull();
});
