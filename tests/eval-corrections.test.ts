import { afterEach, expect, test } from "bun:test";
import { GET } from "@/app/api/eval-cases/route";
import { type CaseGrade, type EvalCase, gradeCase, partitionRegressions } from "@/scripts/eval-corrections";

const ownerSecret = "test-owner-secret";
const FAITHFUL = 768; // matches the current 768px thumbnail / detector input
const LEGACY = 480; // an older small thumbnail, too small to judge presence fairly

function evalCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "case-1",
    capturedAt: "2026-07-09T12:00:00.000Z",
    present: true,
    headphones: false,
    correctedFields: ["present"],
    thumbUrl: "/api/thumb/case-1",
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.OWNER_SECRET;
});

test("a corrected present field the pipeline reproduces is a match", () => {
  const grade = gradeCase(evalCase({ present: false, correctedFields: ["present"] }), { present: false, headphones: false }, FAITHFUL);
  expect(grade.regressed).toBe(false);
  expect(grade.checks).toEqual([{ field: "present", expected: false, actual: false, status: "match" }]);
});

test("a present false-positive is a hard regression at any resolution", () => {
  // Human said away; pipeline still sees a person. Low resolution cannot invent a
  // person, so this fails the gate even on a legacy thumbnail.
  const faithful = gradeCase(evalCase({ present: false, correctedFields: ["present"] }), { present: true, headphones: false }, FAITHFUL);
  const legacy = gradeCase(evalCase({ present: false, correctedFields: ["present"] }), { present: true, headphones: false }, LEGACY);
  expect(faithful.regressed).toBe(true);
  expect(legacy.regressed).toBe(true);
  expect(legacy.checks[0]?.status).toBe("mismatch");
});

test("a present false-negative is a regression on a faithful frame", () => {
  // Human said present; pipeline reads away on a full-size thumbnail — a real miss.
  const grade = gradeCase(evalCase({ present: true, correctedFields: ["present"] }), { present: false, headphones: false }, FAITHFUL);
  expect(grade.regressed).toBe(true);
  expect(grade.checks[0]?.status).toBe("mismatch");
});

test("a present false-negative on a legacy small frame is advisory, not a regression", () => {
  // Same miss but the retained thumbnail is too small — resolution artifact, not
  // a proven regression, so it must not fail the gate.
  const grade = gradeCase(evalCase({ present: true, correctedFields: ["present"] }), { present: false, headphones: false }, LEGACY);
  expect(grade.regressed).toBe(false);
  expect(grade.checks[0]?.status).toBe("low_res");
});

test("a headphones value mismatch is reported but does NOT fail the gate (presence is the priority)", () => {
  const match = gradeCase(evalCase({ present: true, headphones: true, correctedFields: ["headphones"] }), { present: true, headphones: true }, FAITHFUL);
  expect(match.regressed).toBe(false);

  // The model reads no headphones where the human said yes — surfaced as a
  // mismatch, but headphones is allowed to be noisy, so the gate stays green.
  const miss = gradeCase(evalCase({ present: true, headphones: true, correctedFields: ["headphones"] }), { present: true, headphones: false }, FAITHFUL);
  expect(miss.checks[0]?.status).toBe("mismatch");
  expect(miss.regressed).toBe(false);
});

test("headphones presence loss is a regression on a faithful frame but advisory on a legacy one", () => {
  const faithful = gradeCase(evalCase({ present: true, headphones: true, correctedFields: ["headphones"] }), { present: false, headphones: false }, FAITHFUL);
  expect(faithful.regressed).toBe(true);
  expect(faithful.checks[0]).toEqual({ field: "headphones", expected: true, actual: null, status: "presence_lost" });

  const legacy = gradeCase(evalCase({ present: true, headphones: true, correctedFields: ["headphones"] }), { present: false, headphones: false }, LEGACY);
  expect(legacy.regressed).toBe(false);
  expect(legacy.checks[0]?.status).toBe("low_res");
});

test("asserts only the human-corrected fields, ignoring model-authored signals", () => {
  const grade = gradeCase(evalCase({ present: true, headphones: false, correctedFields: ["present"] }), { present: true, headphones: true }, FAITHFUL);
  expect(grade.checks).toHaveLength(1);
  expect(grade.checks[0]?.field).toBe("present");
  expect(grade.regressed).toBe(false);
});

test("grades both fields when both were corrected", () => {
  const grade = gradeCase(
    evalCase({ present: true, headphones: true, correctedFields: ["present", "headphones"] }),
    { present: true, headphones: true },
    FAITHFUL,
  );
  expect(grade.checks.map((check) => check.field)).toEqual(["present", "headphones"]);
  expect(grade.regressed).toBe(false);
});

test("eval-cases export rejects an unauthenticated request", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  const response = await GET(new Request("http://localhost/api/eval-cases"));
  expect(response.status).toBe(401);
});

test("eval-cases export returns cases for the owner", async () => {
  process.env.OWNER_SECRET = ownerSecret;
  const response = await GET(new Request("http://localhost/api/eval-cases", {
    headers: { Authorization: `Bearer ${ownerSecret}` },
  }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { cases: unknown[] };
  expect(Array.isArray(body.cases)).toBe(true);
});

test("partitionRegressions blocks only NEW presence regressions, not baselined ones", () => {
  const grades: CaseGrade[] = [
    { id: "known-offtask", checks: [], regressed: true },
    { id: "fresh-regression", checks: [], regressed: true },
  ];
  const { newRegressions, baselined } = partitionRegressions(grades, { "known-offtask": "accepted" });
  expect(newRegressions.map((grade) => grade.id)).toEqual(["fresh-regression"]);
  expect(baselined.map((grade) => grade.id)).toEqual(["known-offtask"]);
});
