import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analyzeFrame } from "@/lib/vision";

// A real (synthetic GAN, no-licensing) head-and-shoulders photo that COCO-SSD
// detects as present — exercises the "local presence succeeds, VLM unavailable"
// path.
const faceFixture = new Uint8Array(readFileSync(new URL("./fixtures/face.jpg", import.meta.url)));

test("analyzeFrame returns conservative fallback when VLM provider is unavailable", async () => {
  // Save and temporarily unset all VLM provider credentials to simulate failure.
  const prevDashScope = process.env.DASHSCOPE_API_KEY;
  const prevQwen = process.env.QWEN_API_KEY;
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  const prevOpenRouterKey = process.env.OPENROUTER_KEY;
  const prevFixture = process.env.WORK_LIVE_VISION_FIXTURE;

  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.QWEN_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  delete process.env.WORK_LIVE_VISION_FIXTURE; // Force real detector path

  try {
    const signals = await analyzeFrame(faceFixture);

    // Conservative fallback: presence verified locally, but focus quality unknown.
    expect(signals.present).toBe(true);
    expect(signals.headphones).toBe(false);
    expect(signals.note).toBe("Vision unavailable; presence verified locally.");

    // Legacy fields stay at their placeholder values.
    expect(signals.eyesOnScreen).toBe(false);
    expect(signals.posture).toBe("unknown");
  } finally {
    // Restore env vars to avoid polluting other tests.
    if (prevDashScope !== undefined) {
      process.env.DASHSCOPE_API_KEY = prevDashScope;
    }
    if (prevQwen !== undefined) {
      process.env.QWEN_API_KEY = prevQwen;
    }
    if (prevOpenRouter !== undefined) {
      process.env.OPENROUTER_API_KEY = prevOpenRouter;
    }
    if (prevOpenRouterKey !== undefined) {
      process.env.OPENROUTER_KEY = prevOpenRouterKey;
    }
    if (prevFixture !== undefined) {
      process.env.WORK_LIVE_VISION_FIXTURE = prevFixture;
    }
  }
});

test("analyzeFrame does not throw when VLM call fails after local presence succeeds", async () => {
  const prevDashScope = process.env.DASHSCOPE_API_KEY;
  const prevQwen = process.env.QWEN_API_KEY;
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  const prevOpenRouterKey = process.env.OPENROUTER_KEY;
  const prevFixture = process.env.WORK_LIVE_VISION_FIXTURE;

  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.QWEN_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  delete process.env.WORK_LIVE_VISION_FIXTURE;

  try {
    // Should not throw; should return the conservative fallback instead.
    await expect(analyzeFrame(faceFixture)).resolves.toBeDefined();
  } finally {
    if (prevDashScope !== undefined) {
      process.env.DASHSCOPE_API_KEY = prevDashScope;
    }
    if (prevQwen !== undefined) {
      process.env.QWEN_API_KEY = prevQwen;
    }
    if (prevOpenRouter !== undefined) {
      process.env.OPENROUTER_API_KEY = prevOpenRouter;
    }
    if (prevOpenRouterKey !== undefined) {
      process.env.OPENROUTER_KEY = prevOpenRouterKey;
    }
    if (prevFixture !== undefined) {
      process.env.WORK_LIVE_VISION_FIXTURE = prevFixture;
    }
  }
});
