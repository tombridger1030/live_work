import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import sharp from "sharp";
import { z } from "zod";
import { getOptionalEnv } from "@/lib/env";
import type { Signals } from "@/lib/types";

export class VisionAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionAnalysisError";
  }
}

const signalSchema = z.object({
  present: z.boolean(),
  headphones: z.boolean(),
  eyesOnScreen: z.boolean(),
  posture: z.enum(["upright", "slouched", "unknown"]),
  note: z.string().min(1).max(160),
});

const DEFAULT_GATEWAY_VISION_MODEL = "alibaba/qwen3-vl-instruct";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

// What the model must judge from one still. The owner's monitor sits BELOW the
// webcam, so working means looking DOWN — a downward head/eye angle is the normal
// focused pose, not a distraction. The reliable distinction is FULL FACE vs SIDE
// PROFILE: if the whole front of the face is visible they are working; if only a
// side profile shows (face turned away) they are not. That is far more robust for
// a VLM than estimating gaze direction.
const SYSTEM_PROMPT =
  "You analyze a single webcam still for a public work-focus accountability page. " +
  "Reply with ONLY a JSON object — no prose, no markdown fences — with exactly these keys: " +
  "present (boolean: a real person is visibly at the desk in frame), " +
  "headphones (boolean: the person is wearing over-ear or in-ear headphones), " +
  "eyesOnScreen (boolean: see the rule below), " +
  'posture (one of "upright", "slouched", "unknown"), ' +
  "note (a short plain sentence describing what you see, and when eyesOnScreen is false the reason; max 160 characters). " +
  "EYESONSCREEN RULE — the person's monitor sits BELOW the webcam, so when they work they look DOWN; a downward head " +
  "tilt and downward gaze is the NORMAL working position, NOT a distraction. Judge it purely by whether you can see the " +
  "FRONT of their face. Set eyesOnScreen=true whenever the full, front-facing face is visible toward the camera — " +
  "INCLUDING head tilted down to read the monitor, a slight glance to one side, or mid-motion blur — as long as you can " +
  "still see the front of the face. Set eyesOnScreen=false ONLY when you canNOT see the front of the face: a side " +
  "profile, head turned away or over the shoulder, the face hidden because the head is bent so far down that only the " +
  "top/crown of the head shows, or the person clearly turned away from the desk. When in doubt and the face is visible, " +
  "choose true. " +
  'POSTURE: "upright" when sitting up or leaning toward the monitor to work, "slouched" when clearly slumped or reclined ' +
  'back, "unknown" when unsure. ' +
  "PRESENCE/QUALITY: if the image is infrared/night-vision, too dark to make out a person, or too blurry/ambiguous to " +
  "confirm a real person at the desk, report present=false and eyesOnScreen=false.";

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

function parseSignals(content: string | null | undefined): Signals {
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
  return result.data;
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
  return result.data;
}

// Direct Anthropic Messages API fallback. The gateway path is preferred when it
// is configured because model choice lives in one provider/model string there.
async function analyzeViaAnthropic(
  jpeg: Uint8Array,
  apiKey: string,
): Promise<Signals> {
  const client = new Anthropic({ apiKey });
  const model = process.env.WORK_LIVE_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;

  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: Buffer.from(jpeg).toString("base64"),
              },
            },
            {
              type: "text",
              text: "Return the focus-signals JSON for this frame.",
            },
          ],
        },
      ],
    });
  } catch (error) {
    console.error(
      "[work-live] Anthropic vision call failed:",
      (error as Error).message,
    );
    throw new VisionAnalysisError(
      `Anthropic vision call failed: ${(error as Error).message}`,
    );
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return parseSignals(text);
}

// OpenAI-compatible Vercel AI Gateway (AI_GATEWAY_API_KEY / OIDC). Defaults to
// Qwen3 VL because this app needs cheap, fast still-image classification.
async function analyzeViaGateway(
  jpeg: Uint8Array,
  apiKey: string,
): Promise<Signals> {
  const openai = new OpenAI({
    apiKey,
    baseURL: "https://ai-gateway.vercel.sh/v1",
  });

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: process.env.WORK_LIVE_VISION_MODEL || DEFAULT_GATEWAY_VISION_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Return the focus-signals JSON for this frame.",
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
    console.error(
      "[work-live] Gateway vision call failed:",
      (error as Error).message,
    );
    throw new VisionAnalysisError(
      `Gateway vision call failed: ${(error as Error).message}`,
    );
  }

  return parseSignals(completion.choices[0]?.message?.content);
}

// A frame is "too dark" only when it is BOTH dim on average AND nearly uniform.
// A lit face on a dark background is dim on average but highly varied, so it must
// still be scored; uniform murk (near-zero variation) is what the model
// hallucinates a working person from, and is what we reject.
const DARK_LUMA_MAX = 30;
const DARK_STDEV_MIN = 12; // min per-channel stdev; below this a dim frame is uniform murk
// Channel means this close together, while dim, read as colourless night vision.
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
  if (spread < GRAY_SPREAD_MAX && luma < GRAY_LUMA_MAX) {
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
 * Classifies one webcam frame into the four focus signals used by `scoreFrom`.
 *
 * Preconditions: `jpeg` is a single frame and should not be logged or persisted.
 * Postconditions: returns schema-valid signals or throws `VisionAnalysisError`;
 * which provider/model runs is chosen here and hidden behind this interface.
 */
export async function analyzeFrame(jpeg: Uint8Array): Promise<Signals> {
  const fixture = fixtureSignals();
  if (fixture) {
    return fixture;
  }

  const unreadable = await unreadableFrameReason(jpeg);
  if (unreadable) {
    return { present: false, headphones: false, eyesOnScreen: false, posture: "unknown", note: unreadable };
  }

  const small = await downscaleForVision(jpeg);
  const gatewayKey =
    getOptionalEnv("AI_GATEWAY_API_KEY") || getOptionalEnv("VERCEL_OIDC_TOKEN");
  if (gatewayKey) {
    return analyzeViaGateway(small, gatewayKey);
  }

  const anthropicKey = getOptionalEnv("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    return analyzeViaAnthropic(small, anthropicKey);
  }

  throw new VisionAnalysisError(
    "Missing model credentials: set AI_GATEWAY_API_KEY/VERCEL_OIDC_TOKEN (gateway) or ANTHROPIC_API_KEY",
  );
}
