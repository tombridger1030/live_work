export type DeltaSign = "up" | "down" | "zero" | "none";

// A metric's change versus a baseline, ready to render: `delta` is the signed
// token to color (e.g. "+3.9", "−6%"), `deltaNote` the muted descriptor beside
// it, and `deltaSign` drives the color (up → green, down → red, zero/none → gray).
export type Delta = {
  delta: string | null; // null when there is no baseline to compare against
  deltaNote: string;
  deltaSign: DeltaSign;
};

/**
 * Signed change from `baseline` → `current` as a colored token plus a muted
 * note. The default note is the historical full-day comparison; callers can
 * supply a narrower comparison label such as "vs yesterday at this time". Use
 * `suffix` for units that belong inside the colored token, such as `%`.
 *
 * `decimals` matches the metric's own precision (hours show 1, scores and
 * percents 0). The sign is derived from the SAME rounded number that gets
 * displayed, so the color can never disagree with the value: a change that rounds
 * to zero (e.g. +0.04 at 1 decimal) reads as "+0.0" with `deltaSign: "zero"`
 * (gray), not as an "up"/green delta. A null baseline yields no token to color.
 */
export function trend(current: number, baseline: number | null, decimals: 0 | 1, deltaNote = "vs yesterday", suffix = ""): Delta {
  if (baseline === null) return { delta: null, deltaNote: "No baseline", deltaSign: "none" };
  const diff = Number((current - baseline).toFixed(decimals));
  const deltaSign: DeltaSign = diff > 0 ? "up" : diff < 0 ? "down" : "zero";
  return { delta: `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(decimals)}${suffix}`, deltaNote, deltaSign };
}
