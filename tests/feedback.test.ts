import { expect, test } from "bun:test";
import { applySignalCorrection, nextPosture } from "@/lib/feedback";
import type { Signals } from "@/lib/types";

const base: Signals = { present: true, headphones: false, eyesOnScreen: true, posture: "upright", note: "x" };

test("applySignalCorrection flips a boolean and leaves the rest intact", () => {
  const out = applySignalCorrection(base, "headphones", true);
  expect(out.headphones).toBe(true);
  expect(out.present).toBe(true);
  expect(out.eyesOnScreen).toBe(true);
  expect(out.note).toBe("x");
});

test("applySignalCorrection sets a valid posture", () => {
  expect(applySignalCorrection(base, "posture", "slouched").posture).toBe("slouched");
});

test("applySignalCorrection rejects unknown fields and mistyped values", () => {
  expect(() => applySignalCorrection(base, "score", 10)).toThrow();
  expect(() => applySignalCorrection(base, "present", "yes")).toThrow();
  expect(() => applySignalCorrection(base, "posture", "leaning")).toThrow();
});

test("nextPosture cycles upright -> slouched -> unknown -> upright", () => {
  expect(nextPosture("upright")).toBe("slouched");
  expect(nextPosture("slouched")).toBe("unknown");
  expect(nextPosture("unknown")).toBe("upright");
});
