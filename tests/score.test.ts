import { expect, test } from "bun:test";
import { scoreFrom } from "@/lib/score";

test("scoreFrom locks in only on strong present focus signals", () => {
  const result = scoreFrom({
    present: true,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "focused"
  });

  expect(result).toEqual({
    score: 100,
    status: "locked_in"
  });
});

test("scoreFrom scores an absent frame a clean 0 regardless of other signals", () => {
  // Camera disconnected / nobody in frame → away → 0, even if stale signals say
  // headphones/eyes/upright. No presence means no focus.
  const result = scoreFrom({
    present: false,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "not at desk"
  });

  expect(result.status).toBe("away");
  expect(result.score).toBe(0);
});

test("scoreFrom cannot lock in without headphones, even with eyes on and upright", () => {
  // The owner only wears headphones when seriously working, so a no-headphones
  // frame must stay below the locked-in threshold and read as merely "present".
  const result = scoreFrom({
    present: true,
    headphones: false,
    eyesOnScreen: true,
    posture: "upright",
    note: "working but no headphones"
  });

  expect(result.score).toBe(70);
  expect(result.status).toBe("present");
});

test("scoreFrom drops hard when eyes are off the screen (e.g. on a phone)", () => {
  // Present, headphones on, upright — but looking at a phone. Eyes-off alone
  // pulls it into the mid band; losing headphones too lands it near the bottom.
  const eyesOff = scoreFrom({
    present: true,
    headphones: true,
    eyesOnScreen: false,
    posture: "upright",
    note: "glancing at phone"
  });
  expect(eyesOff.score).toBe(72);
  expect(eyesOff.status).toBe("present");

  const eyesOffNoHeadphones = scoreFrom({
    present: true,
    headphones: false,
    eyesOnScreen: false,
    posture: "upright",
    note: "on phone, no headphones"
  });
  expect(eyesOffNoHeadphones.score).toBe(42);
  expect(eyesOffNoHeadphones.status).toBe("present");
});
