import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { analyzeFrame, analyzeFrameWithProvider, auditFrameWithProvider } from "@/lib/vision";
import { POST } from "@/app/api/browser-capture/route";
import { latestSnapshot } from "@/lib/store";

// A real (synthetic GAN, no-licensing) head-and-shoulders photo that COCO-SSD
// detects as present, so control reaches the VLM focus/audit call where the
// provider failover logic under test lives.
const faceFixture = new Uint8Array(readFileSync(new URL("./fixtures/face.jpg", import.meta.url)));

const VISION_UNAVAILABLE_NOTE = "Vision unavailable; presence verified locally.";
const ownerSecret = "test-owner-secret";

// A payload that satisfies BOTH the focus schema (headphones, note) and the
// audit schema (present, headphones, note), so one mock reply serves either call.
const OK_PAYLOAD = JSON.stringify({ present: true, headphones: false, note: "mock ok" });

// The mock encodes the desired behavior in the requested `model` string, so a
// single server can stand in for both providers and every failure class. Each
// hit is counted per model so tests can prove a provider was (or was not) called.
const hits = new Map<string, number>();
let server: Server<undefined>;
let baseURL = "";

function reply(content: string) {
  return Response.json({
    id: "mock",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model?: string };
      const model = body.model ?? "";
      hits.set(model, (hits.get(model) ?? 0) + 1);
      switch (model) {
        case "m-429":
          return Response.json({ error: { message: "quota exhausted", type: "insufficient_quota" } }, { status: 429 });
        case "m-500":
          return Response.json({ error: { message: "server error" } }, { status: 500 });
        case "m-empty":
          return reply("");
        case "m-badjson":
          return reply("the model said no");
        case "m-ok":
        case "m-ok-2":
          return reply(OK_PAYLOAD);
        default:
          return Response.json({ error: { message: `unexpected model ${model}` } }, { status: 400 });
      }
    },
  });
  baseURL = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

// Env vars this suite writes; snapshot once and restore after each test so a
// stray provider key or fixture never leaks into (or out of) these tests.
const MANAGED_ENV = [
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_KEY",
  "WORK_LIVE_VISION_PROVIDERS",
  "WORK_LIVE_QWEN_BASE_URL",
  "DASHSCOPE_BASE_URL",
  "WORK_LIVE_OPENROUTER_BASE_URL",
  "WORK_LIVE_QWEN_VISION_MODEL",
  "WORK_LIVE_OPENROUTER_VISION_MODEL",
  "WORK_LIVE_VISION_MODEL",
  "WORK_LIVE_VISION_FIXTURE",
  "WORK_LIVE_ALLOW_FIXTURE",
  "OWNER_SECRET",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  hits.clear();
});

afterEach(async () => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (existsSync(path.join(process.cwd(), ".work-live"))) {
    await rm(path.join(process.cwd(), ".work-live"), { force: true, recursive: true });
  }
});

// Points both providers at the mock. `openrouter` is primary to mirror the live
// production order (WORK_LIVE_VISION_PROVIDERS=openrouter,qwen).
function useProviders(openrouterModel: string, qwenModel: string) {
  process.env.WORK_LIVE_VISION_PROVIDERS = "openrouter,qwen";
  process.env.OPENROUTER_KEY = "test-openrouter-key";
  process.env.QWEN_API_KEY = "test-qwen-key";
  process.env.WORK_LIVE_OPENROUTER_BASE_URL = baseURL;
  process.env.WORK_LIVE_QWEN_BASE_URL = baseURL;
  process.env.WORK_LIVE_OPENROUTER_VISION_MODEL = openrouterModel;
  process.env.WORK_LIVE_QWEN_VISION_MODEL = qwenModel;
}

// THE outage class: primary provider returns 429 (quota exhausted). Capture must
// fail over to the secondary provider and succeed, not 502.
test("primary 429 fails over to the secondary provider", async () => {
  useProviders("m-429", "m-ok");
  const result = await analyzeFrameWithProvider(faceFixture);

  expect(result.visionProvider).toBe("qwen");
  expect(result.signals.present).toBe(true);
  expect(result.signals.note).toBe("mock ok");
  expect(hits.get("m-429")).toBe(1);
  expect(hits.get("m-ok")).toBe(1);
}, 30000);

// The gpt-5-nano failure I actually observed in the benchmark: a 200 response
// with empty content. It must be treated as a provider failure and fail over.
test("primary empty content fails over to the secondary provider", async () => {
  useProviders("m-empty", "m-ok");
  const result = await analyzeFrameWithProvider(faceFixture);

  expect(result.visionProvider).toBe("qwen");
  expect(result.signals.note).toBe("mock ok");
}, 30000);

// A model that returns prose instead of JSON must not crash capture; fail over.
test("primary malformed JSON fails over to the secondary provider", async () => {
  useProviders("m-badjson", "m-ok");
  const result = await analyzeFrameWithProvider(faceFixture);

  expect(result.visionProvider).toBe("qwen");
  expect(result.signals.note).toBe("mock ok");
}, 30000);

// Order is respected and we never spend a second provider call once the primary
// succeeds (cost + latency guard).
test("primary success short-circuits without calling the secondary", async () => {
  useProviders("m-ok", "m-ok-2");
  const result = await analyzeFrameWithProvider(faceFixture);

  expect(result.visionProvider).toBe("openrouter");
  expect(hits.get("m-ok")).toBe(1);
  expect(hits.get("m-ok-2") ?? 0).toBe(0);
}, 30000);

// Full outage with credentials PRESENT (both providers 429) — distinct from the
// "no credentials configured" path. analyzeFrame must still return the
// conservative present/no-headphones fallback, never throw.
test("both providers 429 yields conservative fallback, not a throw", async () => {
  useProviders("m-429", "m-429");
  const signals = await analyzeFrame(faceFixture);

  expect(signals.present).toBe(true);
  expect(signals.headphones).toBe(false);
  expect(signals.note).toBe(VISION_UNAVAILABLE_NOTE);
  expect(hits.get("m-429")).toBe(2);
}, 30000);

// THE production symptom: /api/browser-capture returned 502 when the provider
// was exhausted. With failover + fallback it must return 200 and store a row.
test("browser-capture route returns 200 fallback when all providers 429", async () => {
  useProviders("m-429", "m-429");
  process.env.OWNER_SECRET = ownerSecret;

  const form = new FormData();
  const buffer = new ArrayBuffer(faceFixture.byteLength);
  new Uint8Array(buffer).set(faceFixture);
  form.set("frame", new Blob([buffer], { type: "image/jpeg" }), "frame.jpg");
  const request = new Request("http://localhost/api/browser-capture", {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerSecret}`, "x-forwarded-for": "failover-test" },
    body: form,
  });

  const response = await POST(request);
  const body = (await response.json()) as { stored: boolean; status: string; visionProvider: string | null };

  expect(response.status).toBe(200);
  expect(body.stored).toBe(true);
  expect(body.status).toBe("present");
  expect(body.visionProvider).toBeNull();
  const latest = await latestSnapshot();
  expect(latest?.note).toBe(VISION_UNAVAILABLE_NOTE);
}, 30000);

// The audit path was refactored to carry provider metadata; it must fail over
// the same way as the focus path so a long-run audit never depends on one vendor.
test("audit path fails over from primary 429 to secondary", async () => {
  useProviders("m-429", "m-ok");
  const result = await auditFrameWithProvider(faceFixture);

  expect(result.visionProvider).toBe("qwen");
  expect(result.signals.present).toBe(true);
  expect(hits.get("m-429")).toBe(1);
  expect(hits.get("m-ok")).toBe(1);
}, 30000);
