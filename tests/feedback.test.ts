import { expect, test } from "bun:test";
import { applySignalCorrection } from "@/lib/feedback";
import type { Signals } from "@/lib/types";

const base: Signals = { present: true, headphones: false, eyesOnScreen: true, posture: "upright", note: "x" };

test("applySignalCorrection flips a boolean and leaves the rest intact", () => {
  const out = applySignalCorrection(base, "headphones", true);
  expect(out.headphones).toBe(true);
  expect(out.present).toBe(true);
  expect(out.eyesOnScreen).toBe(true);
  expect(out.note).toBe("x");
});

test("applySignalCorrection still allows present corrections", () => {
  const out = applySignalCorrection(base, "present", false);
  expect(out.present).toBe(false);
  expect(out.headphones).toBe(false);
});

test("applySignalCorrection rejects removed non-scoring fields and mistyped values", () => {
  expect(() => applySignalCorrection(base, "score", 10)).toThrow();
  expect(() => applySignalCorrection(base, "present", "yes")).toThrow();
  expect(() => applySignalCorrection(base, "posture", "leaning")).toThrow();
  expect(() => applySignalCorrection(base, "eyesOnScreen", false)).toThrow();
});
