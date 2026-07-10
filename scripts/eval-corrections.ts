import sharp from "sharp";
import { correctableFields, type CorrectableField } from "@/lib/feedback";
import { analyzeFrameWithProvider, detectPresenceOnly } from "@/lib/vision";

const DEFAULT_BASE_URL = "https://tally-focus.vercel.app";

// The presence detector scores a 768px frame and the retained public thumbnail is
// now 768px too. Below this width the retained image is an older small thumbnail
// where a "no person" reading is likely a resolution artifact, not a real
// regression — those are reported as advisory (`low_res`) instead of failing the
// gate. A false POSITIVE (a person seen where the human said away) is never
// downgraded: lower resolution cannot invent a person.
const FAITHFUL_MIN_WIDTH = 640;

export type EvalCase = {
  id: string;
  capturedAt: string;
  present: boolean;
  headphones: boolean;
  correctedFields: CorrectableField[];
  thumbUrl: string;
};

// What the current pipeline predicts for a frame. `headphones` is only
// meaningful when `present` is true (the production pipeline only reads focus
// quality once a person is detected).
export type Prediction = {
  present: boolean;
  headphones: boolean;
};

export type FieldCheckStatus = "match" | "mismatch" | "presence_lost" | "low_res";

export type FieldCheck = {
  field: CorrectableField;
  expected: boolean;
  actual: boolean | null;
  status: FieldCheckStatus;
};

export type CaseGrade = {
  id: string;
  checks: FieldCheck[];
  regressed: boolean;
};

/**
 * Grades one corrected snapshot against the current pipeline's prediction.
 *
 * Asserts ONLY the fields a human corrected (`correctedFields`); a still-model-
 * authored signal on the same row is never treated as truth. `frameWidth` is the
 * width of the retained image the pipeline was re-run on: at or above
 * `FAITHFUL_MIN_WIDTH` it matches what production scored, so a wrong reading is a
 * real regression; below it, a "no person" reading (a present false-negative, or
 * a headphones case whose presence was lost) is downgraded to advisory `low_res`
 * because the legacy thumbnail is too small to judge fairly. A false POSITIVE
 * stays a hard `mismatch` at any resolution. Because hours-present reliability
 * is the priority and headphones is allowed to be noisy, `regressed` (the gate)
 * fires ONLY on a presence failure — a `present` mismatch or a `presence_lost`.
 * A headphones value mismatch is reported but never fails the gate.
 */
export function gradeCase(evalCase: EvalCase, prediction: Prediction, frameWidth: number): CaseGrade {
  const faithful = frameWidth >= FAITHFUL_MIN_WIDTH;
  const checks: FieldCheck[] = evalCase.correctedFields.map((field): FieldCheck => {
    if (field === "headphones" && !prediction.present) {
      return { field, expected: evalCase.headphones, actual: null, status: faithful ? "presence_lost" : "low_res" };
    }
    const expected = field === "present" ? evalCase.present : evalCase.headphones;
    const actual = field === "present" ? prediction.present : prediction.headphones;
    if (expected === actual) {
      return { field, expected, actual, status: "match" };
    }
    const falseNegative = field === "present" && expected && !actual;
    return { field, expected, actual, status: !faithful && falseNegative ? "low_res" : "mismatch" };
  });
  return {
    id: evalCase.id,
    checks,
    regressed: checks.some(
      (check) => (check.field === "present" && check.status === "mismatch") || check.status === "presence_lost",
    ),
  };
}

function argValue(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return Bun.argv.includes(name);
}

// Splits regressions into ones already accepted in the baseline (known,
// adjudicated cases like an off-task-while-present label) and genuinely NEW
// ones. Only new regressions fail the gate, so a known-benign case never blocks
// deploys while a real new presence regression still does.
export function partitionRegressions(
  regressed: CaseGrade[],
  baseline: Record<string, string>,
): { newRegressions: CaseGrade[]; baselined: CaseGrade[] } {
  const newRegressions: CaseGrade[] = [];
  const baselined: CaseGrade[] = [];
  for (const grade of regressed) {
    (grade.id in baseline ? baselined : newRegressions).push(grade);
  }
  return { newRegressions, baselined };
}

async function loadBaseline(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {};
  }
  const parsed = (await file.json()) as { acceptedPresenceRegressions?: Record<string, string> };
  return parsed.acceptedPresenceRegressions ?? {};
}

function baseUrl(): string {
  return (
    argValue("--base-url") ??
    process.env.WORK_LIVE_BASE_URL ??
    process.env.WORK_LIVE_PUBLIC_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
}

function requireOwnerSecret(): string {
  const secret = process.env.OWNER_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error("Missing OWNER_SECRET. Set it in local env before running the eval; never paste it into chat.");
  }
  return secret;
}

type ExportedCases = { cases: EvalCase[]; manualOverridesExcluded: number };

async function fetchCases(base: string, secret: string, limit: number): Promise<ExportedCases> {
  const response = await fetch(`${base}/api/eval-cases?limit=${limit}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    throw new Error(`eval-cases export failed: ${response.status}`);
  }
  const body = (await response.json()) as { cases: EvalCase[]; manualOverridesExcluded?: number };
  return {
    cases: body.cases.filter((entry) =>
      entry.correctedFields.every((field) => (correctableFields as readonly string[]).includes(field)),
    ),
    manualOverridesExcluded: body.manualOverridesExcluded ?? 0,
  };
}

// The pipeline only needs the expensive VLM when a headphones judgment is under
// test; a presence-only case is graded by the free local detector.
async function predict(evalCase: EvalCase, frame: Uint8Array): Promise<Prediction> {
  if (evalCase.correctedFields.includes("headphones")) {
    const { signals } = await analyzeFrameWithProvider(frame);
    return { present: signals.present, headphones: signals.headphones };
  }
  const { present } = await detectPresenceOnly(frame);
  return { present, headphones: false };
}

async function main(): Promise<void> {
  const base = baseUrl();
  const secret = requireOwnerSecret();
  const limit = Number(argValue("--limit") ?? 200);
  const allow = Number(argValue("--allow") ?? 0);
  const presenceOnly = hasFlag("--presence-only");
  const baseline = await loadBaseline(argValue("--baseline") ?? "tasks/eval-baseline.json");

  const { cases, manualOverridesExcluded } = await fetchCases(base, secret, limit);
  // Presence-only gate: judge just the physical-presence signal via the free
  // local detector, skipping headphones/VLM entirely (headphones is advisory).
  const scoped = presenceOnly
    ? cases
        .map((entry) => ({ ...entry, correctedFields: entry.correctedFields.filter((field) => field === "present") }))
        .filter((entry) => entry.correctedFields.length > 0)
    : cases;
  const grades: CaseGrade[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const perField = {
    present: { correct: 0, total: 0, lowRes: 0 },
    headphones: { correct: 0, total: 0, presenceLost: 0, lowRes: 0 },
  };

  for (const evalCase of scoped) {
    const thumb = await fetch(`${base}${evalCase.thumbUrl}`);
    if (!thumb.ok) {
      skipped.push({ id: evalCase.id, reason: `thumb ${thumb.status}` });
      continue;
    }
    const frame = new Uint8Array(await thumb.arrayBuffer());
    const width = (await sharp(frame).metadata()).width ?? 0;
    const grade = gradeCase(evalCase, await predict(evalCase, frame), width);
    grades.push(grade);
    for (const check of grade.checks) {
      if (check.field === "present") {
        if (check.status === "low_res") {
          perField.present.lowRes += 1;
        } else {
          perField.present.total += 1;
          if (check.status === "match") {
            perField.present.correct += 1;
          }
        }
        continue;
      }
      if (check.status === "low_res") {
        perField.headphones.lowRes += 1;
      } else if (check.status === "presence_lost") {
        perField.headphones.presenceLost += 1;
      } else {
        perField.headphones.total += 1;
        if (check.status === "match") {
          perField.headphones.correct += 1;
        }
      }
    }
  }

  const regressions = grades.filter((grade) => grade.regressed);
  const { newRegressions, baselined } = partitionRegressions(regressions, baseline);
  const pass = newRegressions.length <= allow;
  console.log(JSON.stringify({
    baseUrl: base,
    presenceOnly,
    faithfulMinWidth: FAITHFUL_MIN_WIDTH,
    caseCount: scoped.length,
    manualOverridesExcluded,
    evaluated: grades.length,
    skipped,
    perField: {
      present: {
        ...perField.present,
        accuracy: perField.present.total === 0 ? null : perField.present.correct / perField.present.total,
      },
      headphones: {
        ...perField.headphones,
        accuracy: perField.headphones.total === 0 ? null : perField.headphones.correct / perField.headphones.total,
      },
    },
    allow,
    newRegressions: newRegressions.map((grade) => ({ id: grade.id, checks: grade.checks })),
    baselinedRegressions: baselined.map((grade) => grade.id),
    headphonesAdvisories: grades
      .filter((grade) => grade.checks.some((check) => check.field === "headphones" && check.status === "mismatch"))
      .map((grade) => grade.id),
    pass,
  }, null, 2));

  if (!pass) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
