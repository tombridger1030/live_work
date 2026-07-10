import { expect, test } from "bun:test";
import { scoreFrom } from "@/lib/score";

test("scoreFrom locks in whenever present and wearing headphones", () => {
  const result = scoreFrom({
    present: true,
    headphones: true,
    eyesOnScreen: false,
    posture: "unknown",
    note: "focused"
  });

  expect(result).toEqual({
    score: 100,
    status: "locked_in"
  });
});

test("scoreFrom scores an absent frame a clean 0 regardless of stale extras", () => {
  const result = scoreFrom({
    present: false,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "not at desk"
  });

  expect(result).toEqual({
    score: 0,
    status: "away"
  });
});

test("scoreFrom is 30/100 when present without headphones", () => {
  const result = scoreFrom({
    present: true,
    headphones: false,
    eyesOnScreen: true,
    posture: "upright",
    note: "working but no headphones"
  });

  expect(result).toEqual({
    score: 30,
    status: "present"
  });
});

test("eyes and posture no longer affect score or status", () => {
  const frontFacing = scoreFrom({
    present: true,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "upright"
  });
  const slouchedLookingAway = scoreFrom({
    present: true,
    headphones: true,
    eyesOnScreen: false,
    posture: "slouched",
    note: "slouched"
  });

  expect(frontFacing).toEqual({ score: 100, status: "locked_in" });
  expect(slouchedLookingAway).toEqual({ score: 100, status: "locked_in" });
});
