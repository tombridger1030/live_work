import { expect, test } from "bun:test";
import sharp from "sharp";
import { FRAME_UNCHANGED_MAX, frameHash, hammingDistance } from "@/lib/frame-hash";

async function solidJpeg(value: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: value, g: value, b: value } } })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

// Left-to-right brightness gradient — strong horizontal structure, so its dHash
// differs sharply from a flat frame.
async function gradientJpeg(): Promise<Uint8Array> {
  const width = 32;
  const height = 32;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round((x / (width - 1)) * 255);
      const index = (y * width + x) * 3;
      raw[index] = value;
      raw[index + 1] = value;
      raw[index + 2] = value;
    }
  }
  const buffer = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
  return new Uint8Array(buffer);
}

test("frameHash is a 16-char (64-bit) hex fingerprint", async () => {
  expect((await frameHash(await solidJpeg(120))).length).toBe(16);
});

test("identical frames hash to distance 0", async () => {
  const frame = await solidJpeg(120);
  expect(hammingDistance(await frameHash(frame), await frameHash(frame))).toBe(0);
});

test("a structurally different frame is well past the unchanged threshold", async () => {
  const flat = await frameHash(await solidJpeg(120));
  const gradient = await frameHash(await gradientJpeg());
  expect(hammingDistance(flat, gradient)).toBeGreaterThan(FRAME_UNCHANGED_MAX);
});

test("mismatched or empty hashes count as fully changed", () => {
  expect(hammingDistance("abc", "abcd")).toBe(Number.MAX_SAFE_INTEGER);
  expect(hammingDistance("", "")).toBe(Number.MAX_SAFE_INTEGER);
});
