import { postureValues, type Posture, type Signals } from "@/lib/types";

// The scored signals a human can correct from the UI. `note` is excluded — only
// the four inputs that actually move the score are correctable.
export const correctableFields = ["present", "headphones", "eyesOnScreen", "posture"] as const;
export type CorrectableField = (typeof correctableFields)[number];

/** Next posture in the upright → slouched → unknown → upright cycle (for tap-to-cycle). */
export function nextPosture(current: Posture): Posture {
  const index = postureValues.indexOf(current);
  return postureValues[(index + 1) % postureValues.length];
}

/**
 * Applies one human signal correction and returns the new signals. Booleans take
 * a boolean; posture takes a valid posture string. Throws on an unknown field or
 * mistyped value so the route rejects bad input — be strict in what you accept.
 */
export function applySignalCorrection(signals: Signals, field: string, value: unknown): Signals {
  if (field === "posture") {
    if (typeof value !== "string" || !(postureValues as readonly string[]).includes(value)) {
      throw new Error("posture must be one of: upright, slouched, unknown");
    }
    return { ...signals, posture: value as Posture };
  }
  if (field === "present" || field === "headphones" || field === "eyesOnScreen") {
    if (typeof value !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
    return { ...signals, [field]: value };
  }
  throw new Error(`unknown correctable field: ${field}`);
}
