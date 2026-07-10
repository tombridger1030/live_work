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
const DEFAULT_MIN_SCORE = 0.5;
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
 * the accept threshold (`WORK_LIVE_PRESENCE_MIN_SCORE`, default 0.5); `score` is
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

  const rawThreshold = getOptionalEnv("WORK_LIVE_PRESENCE_MIN_SCORE");
  const parsedThreshold = rawThreshold ? Number(rawThreshold) : Number.NaN;
  const threshold =
    Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold <= 1
      ? parsedThreshold
      : DEFAULT_MIN_SCORE;
  return { present: best >= threshold, score: best };
}
