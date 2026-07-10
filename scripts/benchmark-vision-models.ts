import OpenAI from "openai";
import { sql } from "@vercel/postgres";
import { snapshotThumbnailBytes } from "@/lib/store";
import { parseSignals } from "@/lib/vision";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_PUBLIC_URL = "https://tally-focus.vercel.app";
const DEFAULT_MODELS = [
  "qwen/qwen3.5-flash-02-23",
  "google/gemma-3-4b-it",
  "mistralai/mistral-small-3.2-24b-instruct",
  "openai/gpt-5-nano"
];
const DEFAULT_CALLS_PER_DAY = [60, 120, 180];
const SYSTEM_PROMPT =
  "You analyze a single webcam still for a public work-focus accountability page. " +
  "A person has ALREADY been detected at the desk in this frame, so do NOT judge presence. " +
  "Reply with ONLY a JSON object — no prose, no markdown fences — with exactly these keys: " +
  "headphones (boolean: the person is wearing over-ear or in-ear headphones), " +
  "note (a short plain sentence describing what you see; max 160 characters).";
const USER_TEXT = "Return the focus-signals JSON for this frame.";

type BenchmarkSource = "postgres" | "public";

type BenchmarkArgs = {
  limit: number;
  minGold: number;
  models: string[];
  callsPerDay: number[];
  source: BenchmarkSource;
  publicUrl: string;
};

type EvalFrame = {
  id: string;
  capturedAt: string;
  headphones: boolean;
  humanVerified: boolean;
  thumbUrl: string | null;
};

type ModelPricing = {
  prompt: number;
  completion: number;
};

type ModelResult = {
  model: string;
  evaluated: number;
  correct: number;
  accuracy: number | null;
  errors: number;
  meanPromptTokens: number | null;
  meanCompletionTokens: number | null;
  meanCostUsd: number | null;
  monthly: { callsPerDay: number; costUsd: number | null }[];
};

function argValue(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

function numberList(value: string | null, fallback: number[]): number[] {
  if (!value) {
    return fallback;
  }
  return value.split(",").map((part) => Number(part.trim())).filter((part) => Number.isFinite(part) && part > 0);
}

function configuredSource(): BenchmarkSource {
  const configured = argValue("--source");
  if (configured === "postgres" || configured === "public") {
    return configured;
  }
  return process.env.POSTGRES_URL || process.env.DATABASE_URL ? "postgres" : "public";
}

function parseArgs(): BenchmarkArgs {
  return {
    limit: Number(argValue("--limit") ?? 24),
    minGold: Number(argValue("--min-gold") ?? 8),
    models: (argValue("--models")?.split(",").map((model) => model.trim()).filter(Boolean)) ?? DEFAULT_MODELS,
    callsPerDay: numberList(argValue("--calls-per-day"), DEFAULT_CALLS_PER_DAY),
    source: configuredSource(),
    publicUrl: argValue("--public-url") ?? process.env.WORK_LIVE_PUBLIC_URL ?? process.env.WORK_LIVE_BASE_URL ?? DEFAULT_PUBLIC_URL
  };
}

function requireOpenRouterKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("Missing OPENROUTER_API_KEY or OPENROUTER_KEY. Set it in local env before running the benchmark; never paste it into chat.");
  }
  return apiKey;
}

async function openRouterPricing(models: string[]): Promise<Map<string, ModelPricing>> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`);
  if (!response.ok) {
    throw new Error(`OpenRouter model list failed: ${response.status}`);
  }
  const body = (await response.json()) as { data: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
  const wanted = new Set(models);
  return new Map(
    body.data
      .filter((model) => wanted.has(model.id))
      .map((model) => [
        model.id,
        {
          prompt: Number(model.pricing?.prompt ?? 0),
          completion: Number(model.pricing?.completion ?? 0)
        }
      ])
  );
}

async function postgresRows(query: "gold" | "pseudo", limit: number): Promise<EvalFrame[]> {
  const result = query === "gold"
    ? await sql`
        SELECT id, captured_at, headphones, COALESCE(human_verified, FALSE) AS human_verified
        FROM snapshots
        WHERE human_verified IS TRUE AND present IS TRUE
        ORDER BY captured_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, captured_at, headphones, COALESCE(human_verified, FALSE) AS human_verified
        FROM snapshots
        WHERE present IS TRUE AND COALESCE(capture_source, '') <> 'absent'
        ORDER BY captured_at DESC
        LIMIT ${limit}
      `;

  return result.rows.map((row) => ({
    id: String(row.id),
    capturedAt: new Date(row.captured_at as string | Date).toISOString(),
    headphones: Boolean(row.headphones),
    humanVerified: Boolean(row.human_verified),
    thumbUrl: null
  }));
}

async function publicRows(publicUrl: string, limit: number): Promise<EvalFrame[]> {
  const response = await fetch(publicUrl);
  if (!response.ok) {
    throw new Error(`Public benchmark source failed: ${response.status}`);
  }

  const decoded = (await response.text()).replaceAll('\\"', '"');
  const matches = decoded.matchAll(
    /"id":"([0-9a-f-]+)","capturedAt":"([^"]+)","present":true,"headphones":(true|false),[\s\S]*?"thumbUrl":"([^"]+)"/g
  );
  const byId = new Map<string, EvalFrame>();
  for (const match of matches) {
    const [, id, capturedAt, headphones, thumbUrl] = match;
    if (!id || !capturedAt || !headphones || !thumbUrl || byId.has(id)) {
      continue;
    }
    byId.set(id, {
      id,
      capturedAt,
      headphones: headphones === "true",
      humanVerified: false,
      thumbUrl
    });
  }

  return Array.from(byId.values())
    .sort((left, right) => new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime())
    .slice(0, limit);
}

async function evalFrames(
  args: BenchmarkArgs
): Promise<{ frames: EvalFrame[]; labelSource: "human_verified" | "pseudo_stored" | "public_pseudo_stored" }> {
  if (args.source === "public") {
    return { frames: await publicRows(args.publicUrl, args.limit), labelSource: "public_pseudo_stored" };
  }

  const gold = await postgresRows("gold", args.limit);
  if (gold.length >= args.minGold) {
    return { frames: gold, labelSource: "human_verified" };
  }
  const pseudo = await postgresRows("pseudo", args.limit);
  return { frames: pseudo, labelSource: "pseudo_stored" };
}

async function frameBytes(frame: EvalFrame, publicUrl: string): Promise<Uint8Array | null> {
  if (frame.thumbUrl) {
    const response = await fetch(new URL(frame.thumbUrl, publicUrl));
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }
  return snapshotThumbnailBytes(frame.id);
}

async function classify(openai: OpenAI, model: string, jpeg: Uint8Array): Promise<{ headphones: boolean; promptTokens: number | null; completionTokens: number | null }> {
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_TEXT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` } }
        ]
      }
    ],
    max_tokens: 220,
    temperature: 0
  });
  const signals = parseSignals(completion.choices[0]?.message?.content);
  return {
    headphones: signals.headphones,
    promptTokens: completion.usage?.prompt_tokens ?? null,
    completionTokens: completion.usage?.completion_tokens ?? null
  };
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function monthlyCost(meanCostUsd: number | null, callsPerDay: number): number | null {
  return meanCostUsd === null ? null : meanCostUsd * callsPerDay * 30;
}

async function benchmarkModel(openai: OpenAI, model: string, frames: EvalFrame[], pricing: ModelPricing | undefined, callsPerDay: number[], publicUrl: string): Promise<ModelResult> {
  let correct = 0;
  let errors = 0;
  const promptTokens: number[] = [];
  const completionTokens: number[] = [];
  const costs: number[] = [];

  for (const frame of frames) {
    const bytes = await frameBytes(frame, publicUrl);
    if (!bytes) {
      errors += 1;
      continue;
    }
    try {
      const result = await classify(openai, model, bytes);
      if (result.headphones === frame.headphones) {
        correct += 1;
      }
      if (result.promptTokens !== null) {
        promptTokens.push(result.promptTokens);
      }
      if (result.completionTokens !== null) {
        completionTokens.push(result.completionTokens);
      }
      if (pricing && result.promptTokens !== null && result.completionTokens !== null) {
        costs.push(result.promptTokens * pricing.prompt + result.completionTokens * pricing.completion);
      }
    } catch (error) {
      errors += 1;
      console.warn(`[benchmark] ${model} failed on ${frame.id}:`, (error as Error).message);
    }
  }

  const evaluated = frames.length - errors;
  const meanCostUsd = mean(costs);
  return {
    model,
    evaluated,
    correct,
    accuracy: evaluated === 0 ? null : correct / evaluated,
    errors,
    meanPromptTokens: mean(promptTokens),
    meanCompletionTokens: mean(completionTokens),
    meanCostUsd,
    monthly: callsPerDay.map((count) => ({ callsPerDay: count, costUsd: monthlyCost(meanCostUsd, count) }))
  };
}

function noteFor(labelSource: "human_verified" | "pseudo_stored" | "public_pseudo_stored"): string {
  if (labelSource === "human_verified") {
    return "Accuracy uses human-corrected snapshots as gold labels.";
  }
  if (labelSource === "public_pseudo_stored") {
    return "Accuracy is agreement with public stored snapshot labels, not human ground truth; use this as a cost/parse smoke test.";
  }
  return "Accuracy uses stored snapshot labels as pseudo-labels because the human-verified set is too small.";
}

async function main(): Promise<void> {
  const args = parseArgs();
  const apiKey = requireOpenRouterKey();
  const [{ frames, labelSource }, pricing] = await Promise.all([
    evalFrames(args),
    openRouterPricing(args.models)
  ]);
  if (frames.length === 0) {
    throw new Error("No benchmark frames found. Need human-verified rows, recent Postgres snapshots, or public page snapshot data.");
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": args.publicUrl,
      "X-Title": "work-live vision benchmark"
    }
  });
  const results: ModelResult[] = [];
  for (const model of args.models) {
    results.push(await benchmarkModel(openai, model, frames, pricing.get(model), args.callsPerDay, args.publicUrl));
  }

  console.log(JSON.stringify({
    source: args.source,
    publicUrl: args.source === "public" ? args.publicUrl : null,
    labelSource,
    frameCount: frames.length,
    frameIds: frames.map((frame) => frame.id),
    models: args.models,
    callsPerDayScenarios: args.callsPerDay,
    note: noteFor(labelSource),
    results
  }, null, 2));
}

await main();
