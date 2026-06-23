import sharp from "sharp";
import { FRAME_UNCHANGED_MAX, frameHash, hammingDistance } from "@/lib/frame-hash";
import { scoreFrom } from "@/lib/score";
import { latestSnapshot, saveSnapshot } from "@/lib/store";
import { toThumbnail } from "@/lib/thumb";
import type { ScoreResult, Settings, Signals, SnapshotRow } from "@/lib/types";
import { analyzeFrame } from "@/lib/vision";

const maxFrameBytes = 4 * 1024 * 1024;

/**
 * Reads the single `frame` upload used by browser and agent capture routes.
 *
 * Preconditions: `request` is a multipart form request whose `frame` field is
 * a JPEG-compatible `File`. Postconditions: returns raw frame bytes, returns
 * `null` when no file was supplied, or throws before reading oversized input.
 */
export async function frameFromRequest(request: Request): Promise<Uint8Array | null> {
  const form = await request.formData();
  const frame = form.get("frame");
  if (!(frame instanceof File)) {
    return null;
  }
  if (frame.size > maxFrameBytes) {
    throw new Error("Frame is too large");
  }
  return new Uint8Array(await frame.arrayBuffer());
}

/**
 * Converts one private webcam frame into the public snapshot artifact.
 *
 * Preconditions: caller has already authorized capture, checked pause state,
 * and supplied a non-empty frame. Postconditions: raw frame bytes are not
 * stored; the persisted row contains only model signals, score, and thumbnail.
 */
export async function saveFrameSnapshot(frame: Uint8Array, settings: Settings): Promise<SnapshotRow> {
  const hash = await frameHash(frame);
  const previous = await latestSnapshot();

  let signals: Signals;
  let score: ScoreResult;
  if (previous?.frameHash && hammingDistance(hash, previous.frameHash) <= FRAME_UNCHANGED_MAX) {
    // Frame is ~identical to the last capture — reuse its reading instead of
    // paying for another vision call. Keeps a fresh visual record cheaply so
    // capture cadence can rise without multiplying model cost.
    signals = {
      present: previous.present,
      headphones: previous.headphones,
      eyesOnScreen: previous.eyesOnScreen,
      posture: previous.posture,
      note: previous.note
    };
    score = { score: previous.score, status: previous.status };
  } else {
    signals = await analyzeFrame(frame);
    score = scoreFrom(signals);
  }

  const thumbnail = await toThumbnail(frame, { blur: settings.blur });
  return saveSnapshot({ signals, score, thumbnail, frameHash: hash });
}

// A small neutral placeholder for an "away" snapshot — there is no real frame to
// store, but the schema (and the filmstrip) want an image. A dark tile reads as
// "you weren't here" next to its 0 score.
async function absentThumbnail(): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 24, g: 24, b: 28 } } })
    .jpeg({ quality: 70 })
    .toBuffer();
  return new Uint8Array(buffer);
}

/**
 * Records an "away" snapshot for a tick where the camera was unavailable — e.g.
 * the external webcam is unplugged, meaning the owner is away from the setup. No
 * frame and no vision call: presence is false so the score is 0, keeping the
 * timeline continuous instead of leaving a gap.
 */
export async function saveAbsentSnapshot(): Promise<SnapshotRow> {
  const signals: Signals = {
    present: false,
    headphones: false,
    eyesOnScreen: false,
    posture: "unknown",
    note: "Away — webcam disconnected, not at setup."
  };
  return saveSnapshot({ signals, score: scoreFrom(signals), thumbnail: await absentThumbnail() });
}
