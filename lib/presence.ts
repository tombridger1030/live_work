import { readFile } from "node:fs/promises";
import path from "node:path";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-converter";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import sharp from "sharp";
import { getOptionalEnv } from "@/lib/env";

export type PresenceResult = {
  /** True when a person clears the accept threshold — a human is at the desk. */
  present: boolean;
  /** Highest "person" confidence found in the frame, 0..1 (0 = none). */
  score: number;
};

// Presence is "is a PERSON at the desk", detected by COCO-SSD object detection
// rather than a frontal-face model. The owner's webcam looks down at the desk,
// so when working they look DOWN and a face detector saw only the crown of their
// head and scored 0 ("away") despite a focused person being right there. A
// person detector keys on the whole body, so a head-down working pose, a side
// profile, and a backlit shape all still register — while an empty chair / room
// yields no "person" box, the "not present" signal the page needs. (The VLM
// still rates focus quality once present; presence and focus stay separate.)
//
// COCO-SSD is deliberate over a pose model (MoveNet): MoveNet's video-oriented
// temporal cropping needs warm state and, run cold on independent 5-min-apart
// stills, missed the very head-down frames this fixes. COCO-SSD is stateless
// object detection — same answer every call.
const PERSON_LABEL = "person";
// Default confidence a "person" box must clear to count as present. Overridable
// via WORK_LIVE_PRESENCE_MIN_SCORE (clamped to 0<x<=1) so strictness can be
// tuned per camera/lighting without a code change.
//
// 0.35, not 0.5, and the number is measured rather than picked. Swept against
// the owner's labelled corpus on 2026-07-27 — 73 frames he confirmed he was
// present in, 8 he confirmed were an empty chair:
//   0.50 -> recovers 41/73, 0/8 false alarms
//   0.35 -> recovers 50/73, 0/8 false alarms
// Empty chairs score below the 0.15 model floor, so the band between "head down
// in dim light" and "nobody there" is wide; 0.35 sits inside it. The detector's
// systematic weakness is a downturned head in low light — exactly the deep-work
// posture — which cost ~6.1 hours wrongly scored as away.
//
// Deliberately NOT lower: this is a public accountability record, where claiming
// unworked time is worse than missing worked time. The two frames in the 0.30-0.50
// band that looked genuinely empty were late-night and dimly lit — which is what
// DIM_FRAME_MIN_SCORE below exists to handle.
const DEFAULT_MIN_SCORE = 0.35;
// The bar a frame must clear when the readability gate flags it as dim or
// colour-cast. HIGHER than normal on purpose: a dim frame is exactly where the
// detector is least trustworthy, so it must prove more, rather than being thrown
// away unseen (which is what used to happen and cost real night-time work).
//
// Measured 2026-07-27 on the owner's night frames under purple LED lighting:
//   EMPTY chair (silhouette reads as a torso)  -> 0.36, 0.36, 0.38, 0.41, 0.43
//   owner actually at the desk                 -> 0.60, 0.73, 0.77, 0.81, 0.84
// 0.55 sits in that gap. Override with WORK_LIVE_PRESENCE_DIM_MIN_SCORE.
const DIM_FRAME_MIN_SCORE = 0.55;
// Floor passed to the model so borderline boxes are still returned and the real
// accept/reject cutoff stays in ONE place (the env-tunable threshold below).
const MODEL_SCORE_FLOOR = 0.15;
const MAX_BOXES = 20;

type WeightGroup = { paths: string[]; weights: tf.io.WeightsManifestEntry[] };

// Reads the vendored graph-model from local files into tfjs ModelArtifacts so
// the model loads offline (no runtime TFHub/Kaggle fetch) and deterministically
// inside the serverless bundle. Weight shards are concatenated in manifest order
// into one contiguous buffer, the layout tfjs expects.
function localModelHandler(dir: string): tf.io.IOHandler {
  return {
    load: async () => {
      const json = JSON.parse(await readFile(path.join(dir, "model.json"), "utf8"));
      const groups = json.weightsManifest as WeightGroup[];
      const weightSpecs = groups.flatMap((group) => group.weights);
      const shards = await Promise.all(
        groups.flatMap((group) => group.paths).map((shard) => readFile(path.join(dir, shard))),
      );
      const total = shards.reduce((sum, shard) => sum + shard.byteLength, 0);
      const weightData = new Uint8Array(total);
      let offset = 0;
      for (const shard of shards) {
        weightData.set(shard, offset);
        offset += shard.byteLength;
      }
      return {
        modelTopology: json.modelTopology,
        weightSpecs,
        weightData: weightData.buffer,
        format: json.format,
        generatedBy: json.generatedBy,
        convertedBy: json.convertedBy,
      };
    },
  };
}

let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;

// Initializes the WASM backend and loads the vendored model exactly once; all
// callers await the same promise. WASM (not native bindings) is deliberate so
// the identical code path runs in local dev and the Vercel Node serverless
// function. A failed init clears the cache so a later call can retry.
function loadModel(): Promise<cocoSsd.ObjectDetection> {
  if (!modelPromise) {
    modelPromise = (async () => {
      // The WASM binaries live in the external, unbundled tfjs package, traced
      // into each serverless function under node_modules. Resolve from cwd (the
      // project root in dev / `next start`, the function root on Vercel), which
      // avoids import.meta (absent in the Next bundle) and createRequire (which
      // webpack rewrites). setWasmPaths wants a trailing separator.
      setWasmPaths(path.join(process.cwd(), "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist") + path.sep);
      await tf.setBackend("wasm");
      await tf.ready();
      const modelDir =
        getOptionalEnv("WORK_LIVE_PRESENCE_MODEL_DIR") || path.join(process.cwd(), "models", "coco-ssd");
      // `modelUrl` is typed `string`, but coco-ssd passes it straight to
      // tf.loadGraphModel, which also accepts an io.IOHandler — so the vendored
      // model loads from disk with no network.
      return cocoSsd.load({ modelUrl: localModelHandler(modelDir) as unknown as string });
    })().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

/**
 * Detects whether a human is present ("a person at the desk") in one frame.
 *
 * Preconditions: `frame` is a single decodable image (JPEG/PNG/...). The caller
 * typically passes a downscaled frame so detection is cheap.
 * Postconditions: `present` is true when the strongest "person" detection clears
 * the accept threshold (`WORK_LIVE_PRESENCE_MIN_SCORE`, default 0.35); `score` is
 * that confidence (0 when none). An absent person — an empty chair, an empty
 * room — returns `{ present: false, score: 0 }`, which the caller treats as
 * "away". Never throws for "no person"; throws only when the backend/model
 * cannot initialize or the frame cannot be decoded.
 */
export async function detectPresence(frame: Uint8Array): Promise<PresenceResult> {
  const model = await loadModel();

  // Decode to raw 3-channel RGB. toColourspace("srgb") guarantees 3 channels so
  // a grayscale/CMYK source can't desync the tensor shape; rotate() honors EXIF
  // so the body is upright for the detector, matching the vision downscale path.
  const { data, info } = await sharp(Buffer.from(frame))
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const input = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], "int32");
  let predictions: cocoSsd.DetectedObject[];
  try {
    predictions = await model.detect(input, MAX_BOXES, MODEL_SCORE_FLOOR);
  } finally {
    input.dispose();
  }

  let best = 0;
  for (const prediction of predictions) {
    if (prediction.class === PERSON_LABEL && prediction.score > best) {
      best = prediction.score;
    }
  }

  return { present: best >= presenceMinScore(), score: best };
}

/** How readable the frame is, which decides which calibrated bar applies. */
export type FrameQuality = "normal" | "dim";

/**
 * The confidence a "person" box must reach for a frame to count as present.
 *
 * `"normal"` reads WORK_LIVE_PRESENCE_MIN_SCORE, `"dim"` reads
 * WORK_LIVE_PRESENCE_DIM_MIN_SCORE; each accepts only a finite number in (0, 1]
 * and otherwise falls back to its calibrated default. Both bars live here so the
 * numbers, their evidence, and their parsing rule stay in one place — raising
 * either silently would re-lose the frames they were tuned to catch.
 *
 * Invariant, ENFORCED rather than merely documented: the dim bar is never below
 * the normal one. The two variables are independent, so an operator could
 * otherwise configure a dim threshold that admits frames the normal gate would
 * reject — turning the empty-chair silhouettes the split exists to exclude
 * (0.36-0.43 under coloured light) into recorded working time. A too-low dim
 * override is raised to the normal bar instead of being honoured.
 */
export function presenceMinScore(quality: FrameQuality = "normal"): number {
  const normal = envScore("WORK_LIVE_PRESENCE_MIN_SCORE", DEFAULT_MIN_SCORE);
  if (quality !== "dim") return normal;
  return Math.max(envScore("WORK_LIVE_PRESENCE_DIM_MIN_SCORE", DIM_FRAME_MIN_SCORE), normal);
}

function envScore(name: string, fallback: number): number {
  const raw = getOptionalEnv(name);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}
