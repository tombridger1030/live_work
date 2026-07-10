import type { Signals } from "@/lib/types";

// Only the two signals that still move score/status are human-correctable.
export const correctableFields = ["present", "headphones"] as const;
export type CorrectableField = (typeof correctableFields)[number];

/**
 * Applies one human signal correction and returns the new signals. Both
 * correctable fields are booleans; anything else is rejected.
 */
export function applySignalCorrection(signals: Signals, field: string, value: unknown): Signals {
  if (field === "present" || field === "headphones") {
    if (typeof value !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
    return { ...signals, [field]: value };
  }
  throw new Error(`unknown correctable field: ${field}`);
}
