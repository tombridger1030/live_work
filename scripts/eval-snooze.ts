import { runSnoozeCompletion, snoozeClient, type SnoozeVerdict } from "@/lib/accountability";

// Cheap instruction-followers worth trying for the snooze judge. Confirmed
// against the live OpenRouter /models list at run time; any missing slug is
// dropped with a warning rather than erroring the whole run.
const DEFAULT_CANDIDATES = [
  "meta-llama/llama-3.1-8b-instruct",
  "mistralai/ministral-3b-2512",
  "qwen/qwen-2.5-7b-instruct",
  "mistralai/mistral-small-24b-instruct-2501",
  "mistralai/ministral-8b-2512",
  "amazon/nova-lite-v1",
  "google/gemini-2.5-flash-lite",
  "mistralai/mistral-small-3.2-24b-instruct",
  "openai/gpt-4o-mini"
];

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const PASS_ACCURACY = 0.9;

type Expect = { action: SnoozeVerdict["action"]; min?: number; max?: number };
type SnoozeCase = { text: string; localTime: string; snoozeMinutesToday: number; expect: Expect };

// Labeled cases spanning the interpreter's contract: plausible grants honoring
// implied duration, and challenges for wrong-time, vague/unparseable, all-day,
// and over-used requests.
const CASES: SnoozeCase[] = [
  { text: "grabbing lunch", localTime: "12:15", snoozeMinutesToday: 0, expect: { action: "grant", min: 20, max: 60 } },
  { text: "having lunch", localTime: "15:00", snoozeMinutesToday: 0, expect: { action: "challenge" } },
  { text: "at the gym", localTime: "17:00", snoozeMinutesToday: 0, expect: { action: "grant", min: 60, max: 120 } },
  { text: "jj 2h", localTime: "18:00", snoozeMinutesToday: 0, expect: { action: "grant", min: 110, max: 130 } },
  { text: "off all day", localTime: "10:00", snoozeMinutesToday: 0, expect: { action: "challenge" } },
  { text: "asdfgh", localTime: "11:00", snoozeMinutesToday: 0, expect: { action: "challenge" } },
  { text: "quick coffee", localTime: "09:30", snoozeMinutesToday: 0, expect: { action: "grant", min: 10, max: 30 } },
  { text: "lunch", localTime: "12:00", snoozeMinutesToday: 210, expect: { action: "challenge" } }
];

type Pricing = { prompt: number; completion: number };

type CaseResult = {
  text: string;
  localTime: string;
  expected: Expect;
  got: { action: SnoozeVerdict["action"]; minutes: number } | null;
  correct: boolean;
  error?: string;
};

type ModelResult = {
  model: string;
  evaluated: number;
  correct: number;
  accuracy: number;
  errors: number;
  meanCostUsd: number | null;
  costPer1kCalls: number | null;
  cases: CaseResult[];
};

function argValue(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

// id -> per-token pricing for the requested models, from the live /models list.
async function openRouterPricing(): Promise<Map<string, Pricing>> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`);
  if (!response.ok) {
    throw new Error(`OpenRouter /models failed: ${response.status}`);
  }
  const body = (await response.json()) as { data: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
  return new Map(body.data.map((model) => [model.id, { prompt: Number(model.pricing?.prompt ?? 0), completion: Number(model.pricing?.completion ?? 0) }]));
}

function scoreCase(verdict: SnoozeVerdict, expect: Expect): boolean {
  if (verdict.action !== expect.action) {
    return false;
  }
  if (expect.action === "grant") {
    if (expect.min !== undefined && verdict.minutes < expect.min) {
      return false;
    }
    if (expect.max !== undefined && verdict.minutes > expect.max) {
      return false;
    }
  }
  return true;
}

async function evalModel(model: string, pricing: Pricing | undefined): Promise<ModelResult> {
  const openai = snoozeClient();
  let correct = 0;
  let errors = 0;
  const costs: number[] = [];
  const cases: CaseResult[] = [];

  for (const testCase of CASES) {
    try {
      const { verdict, promptTokens, completionTokens } = await runSnoozeCompletion(openai, model, testCase.text, {
        localTime: testCase.localTime,
        snoozeMinutesToday: testCase.snoozeMinutesToday
      });
      const ok = scoreCase(verdict, testCase.expect);
      if (ok) {
        correct += 1;
      }
      if (pricing && promptTokens !== null && completionTokens !== null) {
        costs.push(promptTokens * pricing.prompt + completionTokens * pricing.completion);
      }
      cases.push({
        text: testCase.text,
        localTime: testCase.localTime,
        expected: testCase.expect,
        got: { action: verdict.action, minutes: verdict.minutes },
        correct: ok
      });
    } catch (error) {
      errors += 1;
      cases.push({ text: testCase.text, localTime: testCase.localTime, expected: testCase.expect, got: null, correct: false, error: (error as Error).message });
    }
  }

  const evaluated = CASES.length - errors;
  const meanCostUsd = costs.length > 0 ? costs.reduce((total, value) => total + value, 0) / costs.length : null;
  return {
    model,
    evaluated,
    correct,
    accuracy: correct / CASES.length,
    errors,
    meanCostUsd,
    costPer1kCalls: meanCostUsd === null ? null : meanCostUsd * 1000,
    cases
  };
}

// Selection rule (not a judgement call): cheapest candidate at >= 0.9 accuracy;
// if none clear the bar, the highest-accuracy one (ties broken by cost).
function selectModel(results: ModelResult[]): string | null {
  const passing = results.filter((result) => result.accuracy >= PASS_ACCURACY);
  const cost = (result: ModelResult): number => result.costPer1kCalls ?? Number.POSITIVE_INFINITY;
  if (passing.length > 0) {
    return [...passing].sort((left, right) => cost(left) - cost(right) || right.accuracy - left.accuracy)[0].model;
  }
  return [...results].sort((left, right) => right.accuracy - left.accuracy || cost(left) - cost(right))[0]?.model ?? null;
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY or OPENROUTER_KEY. Set it in local env before running; never paste it into chat.");
  }
  const requested = argValue("--models")?.split(",").map((model) => model.trim()).filter(Boolean) ?? DEFAULT_CANDIDATES;
  const pricing = await openRouterPricing();
  const models = requested.filter((model) => {
    if (!pricing.has(model)) {
      console.warn(`[eval-snooze] dropping ${model}: not in live /models list`);
      return false;
    }
    return true;
  });
  if (models.length === 0) {
    throw new Error("No candidate models remain after filtering against the live /models list.");
  }

  const results: ModelResult[] = [];
  for (const model of models) {
    results.push(await evalModel(model, pricing.get(model)));
  }
  results.sort((left, right) => right.accuracy - left.accuracy || (left.costPer1kCalls ?? Number.POSITIVE_INFINITY) - (right.costPer1kCalls ?? Number.POSITIVE_INFINITY));

  const selected = selectModel(results);
  console.log(
    JSON.stringify(
      {
        cases: CASES.length,
        passAccuracy: PASS_ACCURACY,
        selectionRule: "cheapest candidate with accuracy >= 0.9; else highest accuracy (ties cheapest)",
        selected,
        results
      },
      null,
      2
    )
  );
}

await main();
