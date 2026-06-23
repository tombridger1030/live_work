import { expect, test } from "bun:test";
import { trend } from "@/lib/delta";

// The renderer colors by deltaSign: up → green, down → red, zero/none → gray.
const MINUS = "\u2212"; // U+2212, the minus glyph the token uses (not a hyphen)

test("trend marks an increase 'up' (green) with a one-decimal token", () => {
  // Hours present 8.4 vs yesterday's 4.5 → the "+3.9" the user wants in green.
  expect(trend(8.4, 4.5, 1)).toEqual({ delta: "+3.9", deltaNote: "vs yesterday", deltaSign: "up" });
});

test("trend marks a decrease 'down' (red) with a minus-signed token", () => {
  expect(trend(82, 88, 0)).toEqual({ delta: `${MINUS}6`, deltaNote: "vs yesterday", deltaSign: "down" });
  expect(trend(60, 75, 0)).toEqual({ delta: `${MINUS}15`, deltaNote: "vs yesterday", deltaSign: "down" });
});

test("trend marks an exact no-change 'zero' (gray), not green or red", () => {
  expect(trend(82, 82, 0)).toEqual({ delta: "+0", deltaNote: "vs yesterday", deltaSign: "zero" });
  expect(trend(7.5, 7.5, 1)).toEqual({ delta: "+0.0", deltaNote: "vs yesterday", deltaSign: "zero" });
});

test("trend can label a same-time baseline without changing the signed token", () => {
  expect(trend(1.8, 1.2, 1, "vs yesterday at this time")).toEqual({
    delta: "+0.6",
    deltaNote: "vs yesterday at this time",
    deltaSign: "up"
  });
});

test("trend keeps percent units inside the colored token", () => {
  expect(trend(45, 9, 0, "vs yesterday at this time", "%")).toEqual({
    delta: "+36%",
    deltaNote: "vs yesterday at this time",
    deltaSign: "up"
  });
  expect(trend(7, 14, 0, "vs yesterday at this time", "%")).toEqual({
    delta: `${MINUS}7%`,
    deltaNote: "vs yesterday at this time",
    deltaSign: "down"
  });
});

test("trend's color sign matches the displayed rounded number, so a change that rounds to zero stays gray", () => {
  // +0.02 rounds to "+0.0" at one decimal: the token reads zero, so the color
  // MUST be gray (zero), never green (up) — color can't disagree with the value.
  const result = trend(8.42, 8.4, 1);
  expect(result.delta).toBe("+0.0");
  expect(result.deltaSign).toBe("zero");
});

test("trend with no baseline yields no colored token (gray 'No baseline')", () => {
  expect(trend(8.4, null, 1)).toEqual({ delta: null, deltaNote: "No baseline", deltaSign: "none" });
});
