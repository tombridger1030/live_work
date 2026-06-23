import sharp from "sharp";

/**
 * Difference hash (dHash) of a frame: a 64-bit perceptual fingerprint, returned
 * as 16 hex chars. Visually similar frames produce hashes a small Hamming
 * distance apart, so the capture pipeline can cheaply tell "the scene hasn't
 * changed" and skip the paid vision call. Computed from a 9×8 grayscale
 * reduction (8 comparisons per row × 8 rows = 64 bits).
 */
export async function frameHash(jpeg: Uint8Array): Promise<string> {
  const width = 9;
  const height = 8;
  const pixels = await sharp(Buffer.from(jpeg)).grayscale().resize(width, height, { fit: "fill" }).raw().toBuffer();

  let bits = "";
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      bits += pixels[y * width + x] < pixels[y * width + x + 1] ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Number of differing bits between two dHash hex strings. 0 = identical frames;
 * a handful = noise/lighting flicker; larger = the person or scene moved.
 * Returns a large number for mismatched/missing inputs so callers treat them as
 * "changed" (never wrongly skip the vision call).
 */
export function hammingDistance(left: string, right: string): number {
  if (!left || !right || left.length !== right.length) {
    return Number.MAX_SAFE_INTEGER;
  }
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    let xor = parseInt(left[i], 16) ^ parseInt(right[i], 16);
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

// Frames within this Hamming distance count as "unchanged" → reuse the last
// reading instead of calling the vision model. Conservative: only near-identical
// frames are skipped, so a real posture/presence change is never missed.
export const FRAME_UNCHANGED_MAX = 8;
