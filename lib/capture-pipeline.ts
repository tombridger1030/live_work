import sharp from "sharp";
import { captureCadenceLookbackMinutes, shouldStoreCaptureResult } from "@/lib/capture-cadence";
import { FRAME_UNCHANGED_MAX, frameHash, hammingDistance } from "@/lib/frame-hash";
import { analyzeCaptureLiveness, type CaptureLiveness } from "@/lib/frame-liveness";
import { scoreFrom } from "@/lib/score";
import { latestSnapshot, saveSnapshot, snapshotsSince } from "@/lib/store";
import { toThumbnail } from "@/lib/thumb";
import { analyzeFrameWithProvider, auditFrameWithProvider, type FrameAnalysisResult, detectPresenceOnly, VisionAnalysisError } from "@/lib/vision";
import type { CaptureSource, ScoreResult, Settings, Signals, SnapshotRow } from "@/lib/types";

const maxFrameBytes = 4 * 1024 * 1024;
const visionReuseMaxMinutes = 15;
const presenceAuditMaxMinutes = 30;
const statusAuditMaxMinutes = 60;
const classificationLookbackMinutes = statusAuditMaxMinutes + 10;

export type FrameClassificationPlan = "fresh_analysis" | "reuse_previous" | "presence_audit";
export type CaptureUpload = {
  frame: Uint8Array;
  proofFrame: Uint8Array | null;
  source: CaptureSource;
};


function minutesBetween(startIso: string, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - new Date(startIso).getTime()) / 60_000));
}

function similarFrameRunMinutes(previous: SnapshotRow, recentSnapshots: SnapshotRow[], currentHash: string, capturedAt: Date): number {
  let start = previous.capturedAt;
  const previousTime = new Date(previous.capturedAt).getTime();

  for (let index = recentSnapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = recentSnapshots[index];
    if (new Date(snapshot.capturedAt).getTime() > previousTime) {
      continue;
    }
    if (!snapshot.frameHash || hammingDistance(currentHash, snapshot.frameHash) > FRAME_UNCHANGED_MAX) {
      break;
    }
    start = snapshot.capturedAt;
  }


  return minutesBetween(start, capturedAt);
}
async function optionalAuditFrame(frame: Uint8Array): Promise<FrameAnalysisResult | null> {
  try {
    return await auditFrameWithProvider(frame);
  } catch (error) {
    if (error instanceof VisionAnalysisError) {
      return null;
    }
    throw error;
  }
}

function absentSignals(note: string): Signals {
  return { present: false, headphones: false, eyesOnScreen: false, posture: "unknown", note };
}


function sameStatusRunMinutes(
  previous: SnapshotRow,
  recentSnapshots: SnapshotRow[],
  nextStatus: ScoreResult["status"],
  capturedAt: Date
): number {
  if (previous.status !== nextStatus) {
    return 0;
  }

  let start = previous.capturedAt;
  const previousTime = new Date(previous.capturedAt).getTime();
  for (let index = recentSnapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = recentSnapshots[index];
    if (new Date(snapshot.capturedAt).getTime() > previousTime) {
      continue;
    }
    if (snapshot.status !== nextStatus) {
      break;
    }
    start = snapshot.capturedAt;
  }

  return minutesBetween(start, capturedAt);
}

/**
 * Chooses how much evidence one capture needs before storing a classification.
 *
 * Preconditions: `recentSnapshots` are ascending and cover at least
 * `classificationLookbackMinutes`. Postconditions: near-identical frames may
 * reuse the previous VLM reading only for a short run; after 30 minutes the VLM
 * must independently audit presence, so stale "present" or "away" readings
 * cannot coast for hours.
 */
export function frameClassificationPlanFor(
  previous: SnapshotRow | null,
  recentSnapshots: SnapshotRow[],
  currentHash: string,
  capturedAt: Date
): FrameClassificationPlan {
  if (!previous?.frameHash || hammingDistance(currentHash, previous.frameHash) > FRAME_UNCHANGED_MAX) {
    return "fresh_analysis";
  }

  const runMinutes = similarFrameRunMinutes(previous, recentSnapshots, currentHash, capturedAt);
  if (runMinutes >= presenceAuditMaxMinutes) {
    return "presence_audit";
  }
  if (runMinutes > visionReuseMaxMinutes) {
    return "fresh_analysis";
  }
  return "reuse_previous";
}

/**
 * Long same-status runs get a second opinion even when the frame is changing.
 * This bounds both false-present and false-away detector drift.
 */
export function needsStatusRunAudit(
  previous: SnapshotRow | null,
  recentSnapshots: SnapshotRow[],
  nextStatus: ScoreResult["status"],
  capturedAt: Date
): boolean {
  return previous ? sameStatusRunMinutes(previous, recentSnapshots, nextStatus, capturedAt) >= statusAuditMaxMinutes : false;
}


function captureSourceFrom(form: FormData, fallback: CaptureSource): CaptureSource {
  const raw = form.get("source");
  if (raw === "agent" || raw === "browser" || raw === "absent") {
    return raw;
  }
  return fallback;
}

async function frameBytesFrom(value: FormDataEntryValue | null, label: string): Promise<Uint8Array | null> {
  if (!(value instanceof File)) {
    return null;
  }
  if (value.size > maxFrameBytes) {
    throw new Error(`${label} is too large`);
  }
  return new Uint8Array(await value.arrayBuffer());
}

/**
 * Reads the scored `frame` plus optional agent-only `proofFrame` upload.
 *
 * Preconditions: `request` is multipart form data. Postconditions: returns the
 * raw JPEG-compatible bytes plus a capture source; browser uploads can omit the
 * proof frame, but agent uploads are later scored away when proof is missing.
 */
export async function captureUploadFromRequest(
  request: Request,
  fallbackSource: CaptureSource
): Promise<CaptureUpload | null> {
  const form = await request.formData();
  const frame = await frameBytesFrom(form.get("frame"), "Frame");
  if (!frame) {
    return null;
  }

  return {
    frame,
    proofFrame: await frameBytesFrom(form.get("proofFrame"), "Proof frame"),
    source: captureSourceFrom(form, fallbackSource)
  };
}

export type SnapshotSaveResult = {
  stored: boolean;
  snapshot: SnapshotRow | null;
  score: ScoreResult;
  visionProvider?: "qwen" | "openrouter" | null;
  liveness?: CaptureLiveness;
};

async function shouldStoreResult(previous: SnapshotRow | null, nextStatus: ScoreResult["status"], capturedAt: Date): Promise<boolean> {
  if (nextStatus !== "away" || previous?.status !== "away") {
    return true;
  }

  return shouldStoreCaptureResult(
    previous,
    await snapshotsSince(new Date(capturedAt.getTime() - captureCadenceLookbackMinutes * 60_000)),
    nextStatus,
    capturedAt
  );
}

/**
 * Converts one private webcam frame into the public snapshot artifact.
 *
 * Preconditions: caller has already authorized capture, checked pause state,
 * and supplied a non-empty frame. Postconditions: raw frame bytes are not
 * stored; the persisted row contains only model signals, score, and thumbnail;
 * a consecutive away result may be suppressed when AFK backoff is only probing
 * for an immediate return to desk.
 */
export async function saveFrameSnapshot(capture: CaptureUpload, settings: Settings): Promise<SnapshotSaveResult> {
  const capturedAt = new Date();
  const frame = capture.frame;
  const hash = await frameHash(frame);
  const previous = await latestSnapshot();
  const recentSnapshots = previous
    ? await snapshotsSince(new Date(capturedAt.getTime() - classificationLookbackMinutes * 60_000))
    : [];
  const liveness = await analyzeCaptureLiveness({ frame, proofFrame: capture.proofFrame, source: capture.source, previous });
  const plan: FrameClassificationPlan = liveness.status === "weak" ? "fresh_analysis" : frameClassificationPlanFor(previous, recentSnapshots, hash, capturedAt);
  let signals: Signals;
  let score: ScoreResult;
  let visionProvider: SnapshotSaveResult["visionProvider"] = null;
  if (liveness.status === "stale") {
    signals = absentSignals(liveness.note ?? "Away — camera liveness check failed.");
    score = scoreFrom(signals);
  } else if (plan === "presence_audit") {
    const audited = await optionalAuditFrame(frame);
    if (audited) {
      signals = audited.signals;
      visionProvider = audited.visionProvider;
    } else {
      const analyzed = await analyzeFrameWithProvider(frame);
      signals = analyzed.signals;
      visionProvider = analyzed.visionProvider;
    }
    score = scoreFrom(signals);
  } else if (plan === "reuse_previous" && previous) {
    // Frame is briefly ~identical to the last capture — but ALWAYS verify
    // presence with the cheap local COCO-SSD detector before reusing the previous
    // VLM reading. Reuse is capped by `frameClassificationPlanFor`.
    const { present, note } = await detectPresenceOnly(frame);
    if (present) {
      signals = {
        present: previous.present,
        headphones: previous.headphones,
        eyesOnScreen: previous.eyesOnScreen,
        posture: previous.posture,
        note: previous.note
      };
      score = { score: previous.score, status: previous.status };
    } else {
      signals = absentSignals(note);
      score = scoreFrom(signals);
    }
  } else {
    const analyzed = await analyzeFrameWithProvider(frame);
    signals = analyzed.signals;
    visionProvider = analyzed.visionProvider;
    score = scoreFrom(signals);
  }

  if (liveness.status !== "stale" && plan !== "presence_audit" && needsStatusRunAudit(previous, recentSnapshots, score.status, capturedAt)) {
    const audited = await optionalAuditFrame(frame);
    if (audited) {
      signals = audited.signals;
      visionProvider = audited.visionProvider;
      score = scoreFrom(signals);
    }
  }

  if (!(await shouldStoreResult(previous, score.status, capturedAt))) {
    return { stored: false, snapshot: null, score, liveness, visionProvider };
  }

  const thumbnail = await toThumbnail(frame, { blur: settings.blur });
  return {
    stored: true,
    snapshot: await saveSnapshot({
      capturedAt,
      signals,
      score,
      thumbnail,
      frameHash: hash,
      captureSource: capture.source,
      frameSignature: liveness.frameSignature,
      proofSignature: liveness.proofSignature,
      livenessStatus: liveness.status,
      livenessScore: liveness.score
    }),
    score,
    liveness,
    visionProvider
  };
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
 * the external webcam is unplugged or disconnected, meaning the owner is not at
 * the Mac setup (could be gaming on PC or away from desk). No frame and no
 * vision call: presence is false so the score is 0. The first away ticks still
 * land on the timeline; once a long away streak is established, AFK backoff
 * suppresses redundant repeats until the next due sample.
 */
export async function saveAbsentSnapshot(): Promise<SnapshotSaveResult> {
  const signals = absentSignals("Away — webcam disconnected, not at setup.");
  const capturedAt = new Date();
  const score = scoreFrom(signals);
  const previous = await latestSnapshot();
  if (!(await shouldStoreResult(previous, score.status, capturedAt))) {
    return { stored: false, snapshot: null, score };
  }
  return {
    stored: true,
    snapshot: await saveSnapshot({
      capturedAt,
      signals,
      score,
      thumbnail: await absentThumbnail(),
      captureSource: "absent",
      livenessStatus: "not_checked"
    }),
    score
  };
}
