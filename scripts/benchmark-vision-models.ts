// Scores vision models against the owner's OWN corrected frames — the set where
// production actually failed and a human overruled it.
//
// Two things this deliberately does differently from a naive benchmark:
//
//  1. It imports SYSTEM_PROMPT and parseFocusRead from lib/vision rather than
//     copying them. A previous harness kept its own copy of the prompt, silently
//     diverged from production, and every number it printed described an app that
//     did not exist.
//
//  2. It scores balanced accuracy, not raw accuracy. The corrections corpus is
//     ~134 "yes headphones" to ~20 "no", so a model that always answers yes looks
//     97% correct while being useless. recall catches "does it find his
//     headphones", specificity catches "does it invent them", and only the pair
//     is meaningful.
//
// Modes:
//   (default)      score each model in BENCH_MODELS independently
//   --chain        score the production chain end-to-end, measuring what the
//                  unsure-escalation actually buys over the first model alone
//
// Usage:
//   OWNER_SECRET=... WORK_LIVE_DATA_DIR=... bun run scripts/benchmark-vision-models.ts --chain
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { SYSTEM_PROMPT, parseFocusRead } from "@/lib/vision";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const USER_TEXT = "Return the focus-signals JSON for this frame.";
// Mirrors lib/vision's production chain: cheap+reliable first, strong last.
const DEFAULT_CHAIN = ["amazon/nova-2-lite-v1", "bytedance-seed/seed-1.6-flash", "google/gemini-2.5-flash"];

const chainMode = process.argv.includes("--chain");
const models = (process.env.BENCH_MODELS ?? DEFAULT_CHAIN.join(",")).split(",").map((m) => m.trim()).filter(Boolean);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 8);
const maxTrue = Number(process.env.BENCH_MAX_TRUE ?? 1000);
const dir = process.env.WORK_LIVE_DATA_DIR ?? path.join(process.cwd(), ".work-live");
const base = process.env.WORK_LIVE_BASE_URL ?? "http://localhost:3100";

type Case = {
  id: string;
  capturedAt: string;
  headphones: boolean;
  correctedFields: string[];
  modelSaid: { headphones?: boolean };
};

const response = await fetch(`${base}/api/eval-cases?limit=1000`, {
  headers: { Authorization: `Bearer ${process.env.OWNER_SECRET ?? ""}` }
});
if (!response.ok) throw new Error(`eval-cases returned ${response.status} — is the server running and OWNER_SECRET set?`);
const { cases }: { cases: Case[] } = await response.json();

const labelled = cases.filter((entry) => entry.correctedFields.includes("headphones"));
const positives = labelled.filter((entry) => entry.headphones);
const negatives = labelled.filter((entry) => !entry.headphones);
// Every negative is kept — they are the scarce class and the only thing that
// catches a yes-biased model. Positives are sampled evenly across time so one
// long session cannot dominate the score.
const step = Math.max(1, Math.ceil(positives.length / maxTrue));
const frames = [...positives.filter((_, index) => index % step === 0).slice(0, maxTrue), ...negatives]
  .filter((entry) => existsSync(path.join(dir, "thumbs", `${entry.id}.jpg`)));

console.log(`corpus: ${frames.length} frames (${frames.filter((f) => f.headphones).length} wearing / ${frames.filter((f) => !f.headphones).length} not)\n`);

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY,
  baseURL: OPENROUTER_BASE_URL,
  defaultHeaders: { "X-Title": "work-live benchmark" }
});

const images = new Map<string, string>();
for (const frame of frames) images.set(frame.id, (await readFile(path.join(dir, "thumbs", `${frame.id}.jpg`))).toString("base64"));

type Answer = { headphones: boolean; confident: boolean };

async function ask(model: string, id: string): Promise<Answer | null> {
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [
          { type: "text", text: USER_TEXT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${images.get(id)}` } }
        ] }
      ],
      max_tokens: 800,
      temperature: 0
    });
    const read = parseFocusRead(completion.choices[0]?.message?.content);
    return { headphones: read.signals.headphones, confident: read.confident };
  } catch {
    return null;
  }
}

/** Runs `task` over every frame with bounded concurrency, preserving order. */
async function overFrames<T>(task: (frame: Case) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(frames.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= frames.length) return;
        results[index] = await task(frames[index]);
      }
    })
  );
  return results;
}

function score(predictions: (boolean | null)[]): { recall: number; specificity: number; balanced: number; errors: number } {
  let tp = 0, fn = 0, tn = 0, fp = 0, errors = 0;
  predictions.forEach((predicted, index) => {
    if (predicted === null) { errors++; return; }
    if (frames[index].headphones) predicted ? tp++ : fn++;
    else predicted ? fp++ : tn++;
  });
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const specificity = tn + fp === 0 ? 0 : tn / (tn + fp);
  return { recall, specificity, balanced: (recall + specificity) / 2, errors };
}

const pct = (value: number) => `${(value * 100).toFixed(1).padStart(5)}%`;

if (!chainMode) {
  for (const model of models) {
    const answers = await overFrames((frame) => ask(model, frame.id));
    const result = score(answers.map((answer) => answer?.headphones ?? null));
    const unsure = answers.filter((answer) => answer && !answer.confident).length;
    console.log(
      `${model.padEnd(34)} recall ${pct(result.recall)}  spec ${pct(result.specificity)}  ` +
      `balanced ${pct(result.balanced)}  unsure ${String(unsure).padStart(3)}  err ${result.errors}`
    );
  }
  process.exit(0);
}

// --chain: what does escalating on "unsure" actually buy?
const primary = await overFrames((frame) => ask(models[0], frame.id));
const escalated: (boolean | null)[] = [];
let escalations = 0;
let changedAnswer = 0;

for (let index = 0; index < frames.length; index++) {
  const first = primary[index];
  if (first && first.confident) { escalated.push(first.headphones); continue; }
  // Unsure (or failed): walk the rest of the chain exactly as production does.
  let answer: Answer | null = first;
  for (const model of models.slice(1)) {
    escalations++;
    const next = await ask(model, frames[index].id);
    if (next) answer = next;
    if (next?.confident) break;
  }
  if (answer && first && answer.headphones !== first.headphones) changedAnswer++;
  escalated.push(answer?.headphones ?? null);
}

const alone = score(primary.map((answer) => answer?.headphones ?? null));
const withChain = score(escalated);

console.log(`first model alone   recall ${pct(alone.recall)}  spec ${pct(alone.specificity)}  balanced ${pct(alone.balanced)}  err ${alone.errors}`);
console.log(`with escalation     recall ${pct(withChain.recall)}  spec ${pct(withChain.specificity)}  balanced ${pct(withChain.balanced)}  err ${withChain.errors}`);
console.log(`\nescalation fired on ${primary.filter((a) => a && !a.confident).length}/${frames.length} frames (${escalations} extra calls)`);
console.log(`it changed the answer ${changedAnswer} times`);
console.log(`balanced accuracy delta: ${((withChain.balanced - alone.balanced) * 100).toFixed(2)} points`);
process.exit(0);
