import OpenAI from "openai";
import sharp from "sharp";
import { z } from "zod";
import { getOptionalEnv } from "@/lib/env";
import { detectPresence } from "@/lib/presence";
import type { Signals } from "@/lib/types";

export class VisionAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionAnalysisError";
  }
}

const looseNote = z.preprocess((value) => {
  const v = typeof value === "string" ? value.trim() : "";
  return (v || "No additional detail.").slice(0, 160);
}, z.string().min(1).max(160));
// The model now owns only the one live scoring signal it can add beyond the
// deterministic presence detector: headphones. eyesOnScreen/posture are no
// longer part of the public rubric, so the model is not asked for them and they
// cannot break capture if omitted or malformed. note stays best-effort and is
// clamped because the public page still shows it.
const signalSchema = z.object({
  headphones: z.boolean(),
  note: looseNote,
});
const auditSignalSchema = z.object({
  present: z.boolean(),
  headphones: z.boolean(),
  note: looseNote
});


const DEFAULT_QWEN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_VISION_MODEL = "qwen3.6-flash";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_VISION_MODEL = "qwen/qwen3.5-flash-02-23";
const VISION_UNAVAILABLE_NOTE = "Vision unavailable; presence verified locally.";

// Normal captures use the local person detector for presence first, then ask the
// VLM only for focus quality. This deliberately avoids letting the VLM hallucinate
// presence on every ordinary frame.
const SYSTEM_PROMPT =
  "You analyze a single webcam still for a public work-focus accountability page. " +
  "A person has ALREADY been detected at the desk in this frame, so do NOT judge presence. " +
  "Reply with ONLY a JSON object — no prose, no markdown fences — with exactly these keys: " +
  "headphones (boolean: the person is wearing over-ear or in-ear headphones), " +
  "note (a short plain sentence describing what you see; max 160 characters).";

// Long-run audits are different: they exist to challenge a status that has stayed
// unchanged too long. If uncertain, the audit must mark not-present so one bad
// detector reading cannot become hours of fake accountability.
const AUDIT_SYSTEM_PROMPT =
  "You audit a single webcam still because the automated desk-presence status may be stale or wrong. " +
  "Decide whether a real human is visibly at the desk RIGHT NOW. If uncertain, blocked, too dark, a screen/photo/reflection, or only an object/chair is visible, set present=false. " +
  "Set headphones=true only when present=true and headphones are clearly visible. " +
  "Reply with ONLY a JSON object — no prose, no markdown fences — with exactly these keys: " +
  "present (boolean), headphones (boolean), note (a short plain sentence explaining the visual evidence; max 160 characters).";


// Pull the JSON object out of a model reply, tolerating code fences or stray
// prose so an occasional non-pure reply still validates instead of 502-ing.
function extractJsonObject(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return body.trim();
  }
  return body.slice(start, end + 1);
}

export function parseSignals(content: string | null | undefined): Signals {
  if (!content || content.trim().length === 0) {
    throw new VisionAnalysisError("Vision model returned no content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(content));
  } catch (error) {
    throw new VisionAnalysisError(
      `Vision model returned invalid JSON: ${(error as Error).message}`,
    );
  }

  const result = signalSchema.safeParse(parsed);
  if (!result.success) {
    throw new VisionAnalysisError(
      "Vision model returned schema-invalid signals",
    );
  }
  return {
    present: true,
    headphones: result.data.headphones,
    eyesOnScreen: false,
    posture: "unknown",
    note: result.data.note,
  };
}
export function parsePresenceAudit(content: string | null | undefined): Signals {
  if (!content || content.trim().length === 0) {
    throw new VisionAnalysisError("Vision audit returned no content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(content));
  } catch (error) {
    throw new VisionAnalysisError(
      `Vision audit returned invalid JSON: ${(error as Error).message}`,
    );
  }

  const result = auditSignalSchema.safeParse(parsed);
  if (!result.success) {
    throw new VisionAnalysisError("Vision audit returned schema-invalid signals");
  }

  return {
    present: result.data.present,
    headphones: result.data.present ? result.data.headphones : false,
    eyesOnScreen: false,
    posture: "unknown",
    note: result.data.note,
  };
}


function fixtureSignals(): Signals | null {
  const fixture = process.env.WORK_LIVE_VISION_FIXTURE;
  if (!fixture) {
    return null;
  }
  // A fixture returns canned signals WITHOUT calling the model — it exists only
  // for automated tests. If we honored it whenever the env var was present, a
  // stray fixture (e.g. left in .env.local) would make the public page show fake
  // "locked in" data forever. Require an explicit, test-only opt-in, never honor
  // it in production, and log loudly so a fixture can never be silently active.
  const allowed =
    process.env.WORK_LIVE_ALLOW_FIXTURE === "1" &&
    process.env.NODE_ENV !== "production";
  if (!allowed) {
    console.warn(
      "[work-live] WORK_LIVE_VISION_FIXTURE is set but IGNORED — fixtures run only under tests " +
        "(WORK_LIVE_ALLOW_FIXTURE=1, non-production). Remove it from .env.local to use the real model.",
    );
    return null;
  }
  console.warn(
    "[work-live] VISION FIXTURE ACTIVE — returning canned signals, not real model output.",
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(fixture);
  } catch (error) {
    throw new VisionAnalysisError(
      `Vision fixture is invalid JSON: ${(error as Error).message}`,
    );
  }

  const result = signalSchema.safeParse(parsed);
  if (!result.success) {
    throw new VisionAnalysisError("Vision fixture is schema-invalid");
  }
  return {
    present: true,
    headphones: result.data.headphones,
    eyesOnScreen: false,
    posture: "unknown",
    note: result.data.note,
  };
}

type VisionProvider = {
  name: "qwen" | "openrouter";
  apiKey: string;
  baseURL: string;
  model: string;
  headers?: Record<string, string>;
};

export type FrameAnalysisResult = {
  signals: Signals;
  visionProvider: VisionProvider["name"] | null;
};

function visionProviderOrder(): VisionProvider["name"][] {
  const configured = getOptionalEnv("WORK_LIVE_VISION_PROVIDERS");
  const names = (configured ?? "qwen,openrouter")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is VisionProvider["name"] => name === "qwen" || name === "openrouter");
  return names.length > 0 ? names : ["qwen", "openrouter"];
}

function configuredVisionProviders(): VisionProvider[] {
  const qwenKey = getOptionalEnv("DASHSCOPE_API_KEY") || getOptionalEnv("QWEN_API_KEY");
  const openRouterKey = getOptionalEnv("OPENROUTER_API_KEY") || getOptionalEnv("OPENROUTER_KEY");
  const providers: Partial<Record<VisionProvider["name"], VisionProvider>> = {};

  if (qwenKey) {
    providers.qwen = {
      name: "qwen",
      apiKey: qwenKey,
      baseURL: getOptionalEnv("WORK_LIVE_QWEN_BASE_URL") || getOptionalEnv("DASHSCOPE_BASE_URL") || DEFAULT_QWEN_BASE_URL,
      model: getOptionalEnv("WORK_LIVE_QWEN_VISION_MODEL") || getOptionalEnv("WORK_LIVE_VISION_MODEL") || DEFAULT_QWEN_VISION_MODEL
    };
  }

  if (openRouterKey) {
    providers.openrouter = {
      name: "openrouter",
      apiKey: openRouterKey,
      baseURL: getOptionalEnv("WORK_LIVE_OPENROUTER_BASE_URL") || DEFAULT_OPENROUTER_BASE_URL,
      model: getOptionalEnv("WORK_LIVE_OPENROUTER_VISION_MODEL") || DEFAULT_OPENROUTER_VISION_MODEL,
      headers: {
        "HTTP-Referer": getOptionalEnv("WORK_LIVE_PUBLIC_URL") || "https://tally-focus.vercel.app",
        "X-Title": "work-live"
      }
    };
  }

  return visionProviderOrder().flatMap((name) => {
    const provider = providers[name];
    return provider ? [provider] : [];
  });
}

// Direct OpenAI-compatible vision APIs. Qwen/DashScope remains first for existing
// deployments; OpenRouter can be enabled as a cheap failover by setting
// OPENROUTER_API_KEY or OPENROUTER_KEY. Provider selection is private so capture
// keeps returning plain Signals and benchmark plumbing stays out of the production interface.
async function analyzeViaProvider(
  provider: VisionProvider,
  jpeg: Uint8Array,
  systemPrompt = SYSTEM_PROMPT,
  userText = "Return the focus-signals JSON for this frame.",
  parse = parseSignals,
): Promise<Signals> {
  // maxRetries: 0 — with multi-provider failover the NEXT provider is the retry.
  // Retrying an exhausted/429 provider here just burns the serverless invocation
  // (and caused the outage where every capture stalled on a dead Qwen) before we
  // ever try the fallback. Fail fast; the loop below moves to the next provider.
  const openai = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL, defaultHeaders: provider.headers, maxRetries: 0 });

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: provider.model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userText,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`,
              },
            },
          ],
        },
      ],
      max_tokens: 220,
      temperature: 0,
    });
  } catch (error) {
    throw new VisionAnalysisError(
      `${provider.name} vision call failed: ${(error as Error).message}`,
    );
  }

  return parse(completion.choices[0]?.message?.content);
}

type VisionProviderResult = {
  signals: Signals;
  provider: VisionProvider["name"];
};

async function analyzeWithVisionProviders(
  jpeg: Uint8Array,
  systemPrompt = SYSTEM_PROMPT,
  userText = "Return the focus-signals JSON for this frame.",
  parse = parseSignals,
): Promise<VisionProviderResult> {
  const providers = configuredVisionProviders();
  if (providers.length === 0) {
    throw new VisionAnalysisError("Missing vision credentials: set OPENROUTER_API_KEY, OPENROUTER_KEY, DASHSCOPE_API_KEY, or QWEN_API_KEY");
  }

  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const signals = await analyzeViaProvider(provider, jpeg, systemPrompt, userText, parse);
      return { signals, provider: provider.name };
    } catch (error) {
      const message = error instanceof VisionAnalysisError ? error.message : (error as Error).message;
      failures.push(message);
      console.warn("[work-live] Vision provider failed:", message);
    }
  }

  throw new VisionAnalysisError(`Vision providers failed: ${failures.join("; ")}`);
}

// A frame is "too dark" only when it is BOTH dim on average AND nearly uniform.
// A lit face on a dark background is dim on average but highly varied, so it must
// still be scored; uniform murk (near-zero variation) is what the model
// hallucinates a working person from, and is what we reject.
const DARK_LUMA_MAX = 30;
const DARK_STDEV_MIN = 12; // min per-channel stdev; below this a dim frame is uniform murk
// Dim, low-colour AND near-uniform reads as grayscale night vision. The stdev
// floor (shared with the dark gate) is what separates uniform murk from a real
// but dimly-lit face — high per-channel variance means a person is in frame, so
// it must still be scored, not gated to "away".
const GRAY_SPREAD_MAX = 12;
const GRAY_LUMA_MAX = 70;
// Green this far above both red and blue, with little red/blue colour, is the
// classic infrared/night-vision green cast.
const GREEN_DOMINANCE = 1.7;
const GREEN_OTHER_MAX = 70;

/**
 * Flags a frame the model cannot honestly read for presence — a dark room or an
 * infrared/night-vision capture — returning a plain note when the frame is
 * unusable, or null when it is worth scoring. The caller records the note as an
 * "away / can't verify" snapshot instead of letting the model hallucinate a
 * working person from murky pixels (the 12am night-vision false-positive).
 * Deliberately conservative: it trips only on strong dark/IR signatures so a
 * real working frame is never turned into a false "away".
 */
export async function unreadableFrameReason(jpeg: Uint8Array): Promise<string | null> {
  let r: number;
  let g: number;
  let b: number;
  let stdevMin: number;
  try {
    const { channels } = await sharp(Buffer.from(jpeg)).stats();
    const [cr, cg, cb] = channels;
    if (!cr || !cg || !cb) {
      return null; // not RGB / stats unavailable → let the model judge
    }
    r = cr.mean;
    g = cg.mean;
    b = cb.mean;
    stdevMin = Math.min(cr.stdev, cg.stdev, cb.stdev);
  } catch {
    return null; // can't assess the frame → defer to the model
  }

  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luma < DARK_LUMA_MAX && stdevMin < DARK_STDEV_MIN) {
    return "Frame too dark to verify presence.";
  }

  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < GRAY_SPREAD_MAX && luma < GRAY_LUMA_MAX && stdevMin < DARK_STDEV_MIN) {
    return "Dim grayscale night-vision frame; cannot verify presence.";
  }

  if (g >= GREEN_DOMINANCE * r && g >= GREEN_DOMINANCE * b && r < GREEN_OTHER_MAX && b < GREEN_OTHER_MAX) {
    return "Infrared/night-vision frame; cannot verify presence.";
  }

  return null;
}

// The model downsamples anything past its limit and bills per 28px patch, so a
// full-res webcam frame is wasted tokens and latency. 768px on the long edge is
// ample to judge presence/eyes/posture and well above the ~200px floor where
// accuracy drops. Falls back to the original frame if the resize fails.
async function downscaleForVision(jpeg: Uint8Array): Promise<Uint8Array> {
  try {
    const out = await sharp(Buffer.from(jpeg))
      .rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return new Uint8Array(out);
  } catch {
    return jpeg;
  }
}

/**
 * Best-effort focus-quality read from the VLM (headphones + note only). Only
 * called once a person has been detected, so the caller ignores its `present`.
 * Tries configured OpenAI-compatible providers in order; failures are handled by
 * the caller so capture availability does not depend on one vendor's quota.
 */
async function analyzeFocusQuality(small: Uint8Array): Promise<VisionProviderResult> {
  return analyzeWithVisionProviders(small);
}

async function analyzePresenceAudit(small: Uint8Array): Promise<VisionProviderResult> {
  return analyzeWithVisionProviders(
    small,
    AUDIT_SYSTEM_PROMPT,
    "Return the audited presence JSON for this frame.",
    parsePresenceAudit
  );
}


// The honest reading for a frame with no verifiable person: away, zero focus.
function awaySignals(note: string): Signals {
  return { present: false, headphones: false, eyesOnScreen: false, posture: "unknown", note };
}

/**
 * Classifies one webcam frame into focus signals and reports which remote
 * provider supplied the focus-quality read.
 *
 * Presence is decided DETERMINISTICALLY by a person detector, not the VLM: a
 * frame with no person — an empty chair, an empty room, or the owner away from
 * the desk — returns `present:false` ("away") WITHOUT calling the VLM, removing
 * the false "present" the VLM used to hallucinate from such frames (and saving a
 * model call). Only when a person is found is the VLM asked to rate focus
 * quality, and presence is forced true to match the detector.
 *
 * Preconditions: `jpeg` is a single frame and should not be logged or persisted.
 * Postconditions: `signals` has the same semantics as `analyzeFrame`; if local
 * presence succeeds but every VLM provider is unavailable, it returns a
 * conservative present/no-headphones reading so a quota outage never blocks
 * check-ins or creates fake locked-in time. `visionProvider` is `"qwen"` or
 * `"openrouter"` only when that provider returned the focus-quality read; it is
 * `null` for fixtures, unreadable frames, no-person frames, and conservative
 * fallback. The provider name is request metadata; it is not persisted into
 * snapshot signals.
 */
export async function analyzeFrameWithProvider(jpeg: Uint8Array): Promise<FrameAnalysisResult> {
  const fixture = fixtureSignals();
  if (fixture) {
    return { signals: fixture, visionProvider: null };
  }

  const unreadable = await unreadableFrameReason(jpeg);
  if (unreadable) {
    return { signals: awaySignals(unreadable), visionProvider: null };
  }

  const small = await downscaleForVision(jpeg);

  const { present } = await detectPresence(small);
  if (!present) {
    return { signals: awaySignals("No person detected — turned away or not at the desk."), visionProvider: null };
  }

  try {
    const quality = await analyzeFocusQuality(small);
    return { signals: { ...quality.signals, present: true }, visionProvider: quality.provider };
  } catch (error) {
    if (!(error instanceof VisionAnalysisError)) {
      throw error;
    }
    console.warn("[work-live] Vision unavailable after local presence; storing conservative fallback:", error.message);
    return {
      signals: {
        present: true,
        headphones: false,
        eyesOnScreen: false,
        posture: "unknown",
        note: VISION_UNAVAILABLE_NOTE
      },
      visionProvider: null
    };
  }
}

/**
 * Classifies one webcam frame into the focus signals used by `scoreFrom`,
 * omitting the non-persisted provider metadata returned by
 * `analyzeFrameWithProvider`.
 */
export async function analyzeFrame(jpeg: Uint8Array): Promise<Signals> {
  return (await analyzeFrameWithProvider(jpeg)).signals;
}
/**
 * Audits a frame with the VLM as an independent presence check and reports the
 * provider that supplied that audit.
 *
 * Preconditions: use only when a status has run long enough that the cheap
 * detector/reuse path must be challenged. Postconditions: returns a full
 * `Signals` object where `present=false` on uncertainty, stale-looking frames,
 * or no visible human. `visionProvider` is `null` only when the frame is rejected
 * before any remote provider call.
 */
export async function auditFrameWithProvider(jpeg: Uint8Array): Promise<FrameAnalysisResult> {
  const unreadable = await unreadableFrameReason(jpeg);
  if (unreadable) {
    return { signals: awaySignals(unreadable), visionProvider: null };
  }

  const audited = await analyzePresenceAudit(await downscaleForVision(jpeg));
  return { signals: audited.signals, visionProvider: audited.provider };
}

/**
 * Audits a frame with the VLM as an independent presence check, omitting the
 * non-persisted provider metadata returned by `auditFrameWithProvider`.
 */
export async function auditFrame(jpeg: Uint8Array): Promise<Signals> {
  return (await auditFrameWithProvider(jpeg)).signals;
}


/**
 * Checks whether a person is present in a frame using the local COCO-SSD
 * detector, WITHOUT calling the VLM. Used by the capture pipeline to always
 * verify presence even when the frame hash shortcut skips the expensive VLM
 * focus-quality call.
 *
 * Postconditions: returns `{ present, note }` — present is true only when a
 * real person clears the detection threshold; note describes the absence
 * reason (dark frame, no person) or is empty when present.
 */
export async function detectPresenceOnly(jpeg: Uint8Array): Promise<{ present: boolean; note: string }> {
  const unreadable = await unreadableFrameReason(jpeg);
  if (unreadable) {
    return { present: false, note: unreadable };
  }

  const small = await downscaleForVision(jpeg);
  const { present } = await detectPresence(small);
  return {
    present,
    note: present ? "" : "No person detected — turned away or not at the desk."
  };
}
