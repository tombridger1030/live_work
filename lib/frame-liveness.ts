import { createHash } from "node:crypto";
import sharp from "sharp";
import type { CaptureSource, LivenessStatus, SnapshotRow } from "@/lib/types";

export type CaptureLiveness = {
  frameSignature: string | null;
  proofSignature: string | null;
  status: LivenessStatus;
  score: number | null;
  note: string | null;
};

export type CaptureLivenessInput = {
  frame: Uint8Array;
  proofFrame?: Uint8Array | null;
  source: CaptureSource;
  previous: SnapshotRow | null;
};

const signatureWidth = 320;
const signatureHeight = 240;
const weakMeanDeltaMax = 0.35;
const weakChangedPixelRatioMax = 0.005;

async function normalizedPixels(frame: Uint8Array): Promise<Buffer> {
  return sharp(Buffer.from(frame))
    .rotate()
    .resize(signatureWidth, signatureHeight, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
}

async function pixelSignature(frame: Uint8Array): Promise<{ pixels: Buffer; signature: string }> {
  const pixels = await normalizedPixels(frame);
  return { pixels, signature: createHash("sha256").update(pixels).digest("hex") };
}


function deltaScore(left: Buffer, right: Buffer): { meanDelta: number; changedRatio: number } {
  let total = 0;
  let changed = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = Math.abs(left[index] - right[index]);
    total += delta;
    if (delta > 1) {
      changed += 1;
    }
  }

  return {
    meanDelta: total / left.length,
    changedRatio: changed / left.length
  };
}

/**
 * Proves one agent tick is a live camera read, not a replayed still image.
 *
 * Preconditions: `frame` is the scored JPEG and `proofFrame` is a second JPEG
 * captured by the local agent during the same tick. Postconditions: browser
 * captures are measured but not blocked; agent captures without an independent
 * proof frame, or with decoded-pixel-identical proof/repeated frames, are marked
 * stale so the caller can score them away instead of trusting a single frame.
 */
export async function analyzeCaptureLiveness(input: CaptureLivenessInput): Promise<CaptureLiveness> {
  const { pixels: framePixels, signature: frameSignature } = await pixelSignature(input.frame);

  if (input.source !== "agent") {
    return { frameSignature, proofSignature: null, status: "not_checked", score: null, note: null };
  }

  if (!input.proofFrame) {
    return {
      frameSignature,
      proofSignature: null,
      status: "stale",
      score: 0,
      note: "Away — agent did not include a second liveness frame."
    };
  }

  const { pixels: proofPixels, signature: proofSignature } = await pixelSignature(input.proofFrame);
  if (frameSignature === proofSignature) {
    return {
      frameSignature,
      proofSignature,
      status: "stale",
      score: 0,
      note: "Away — camera liveness check saw identical decoded frames."
    };
  }

  if (input.previous?.captureSource === "agent" && input.previous.frameSignature === frameSignature) {
    return {
      frameSignature,
      proofSignature,
      status: "stale",
      score: 0,
      note: "Away — camera repeated the previous decoded frame."
    };
  }

  const { meanDelta, changedRatio } = deltaScore(framePixels, proofPixels);
  const score = Number(meanDelta.toFixed(3));
  if (meanDelta <= weakMeanDeltaMax && changedRatio <= weakChangedPixelRatioMax) {
    return {
      frameSignature,
      proofSignature,
      status: "weak",
      score,
      note: "Camera liveness was weak; scored from the fresh frame only."
    };
  }

  return { frameSignature, proofSignature, status: "fresh", score, note: null };
}
