// Temporary diagnostic: isolates the real vision call from camera + Next runtime.
// bun auto-loads .env.local, so this sees the real ANTHROPIC_API_KEY without me
// reading the file. Generates a test JPEG and runs the direct Anthropic Haiku
// path exactly like lib/vision.ts. Delete after use.
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

function present(name: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? "SET" : "missing";
}

for (const k of [
  "ANTHROPIC_API_KEY",
  "AI_GATEWAY_API_KEY",
  "OWNER_SECRET",
  "WORK_LIVE_VISION_FIXTURE",
]) {
  console.log(`${k}: ${present(k)}`);
}

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.log(
    "\nNo ANTHROPIC_API_KEY present — cannot test direct Anthropic path. Stopping.",
  );
  process.exit(1);
}

const model = process.env.WORK_LIVE_ANTHROPIC_MODEL || "claude-haiku-4-5";
console.log(`\n=== Anthropic vision call (model=${model}) ===`);

// A flat grey rectangle: a real model should report present:false (no person).
const jpeg = await sharp({
  create: {
    width: 256,
    height: 192,
    channels: 3,
    background: { r: 90, g: 90, b: 110 },
  },
})
  .jpeg()
  .toBuffer();

const client = new Anthropic({ apiKey });

try {
  const message = await client.messages.create({
    model,
    max_tokens: 300,
    system:
      "You analyze a single webcam still. Reply with ONLY a JSON object with keys " +
      "present (boolean), headphones (boolean), eyesOnScreen (boolean), " +
      'posture ("upright"|"slouched"|"unknown"), note (string, max 160 chars). ' +
      "Be strict: present/eyesOnScreen true only when clearly true.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: jpeg.toString("base64"),
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
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  console.log("OK. Raw model reply:");
  console.log(text);
  console.log("\nusage:", JSON.stringify(message.usage));
} catch (error) {
  const e = error as { status?: number; message?: string };
  console.log("ANTHROPIC ERROR");
  console.log("status:", e.status);
  console.log("message:", e.message);
}
