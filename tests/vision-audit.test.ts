import { expect, test } from "bun:test";
import { parsePresenceAudit } from "@/lib/vision";

test("parsePresenceAudit forces headphones off when no person is present", () => {
  const signals = parsePresenceAudit(JSON.stringify({
    present: false,
    headphones: true,
    note: "Only an empty chair is visible."
  }));

  expect(signals).toEqual({
    present: false,
    headphones: false,
    eyesOnScreen: false,
    posture: "unknown",
    note: "Only an empty chair is visible."
  });
});

test("parsePresenceAudit accepts a visible person with headphones", () => {
  const signals = parsePresenceAudit("```json\n{\"present\":true,\"headphones\":true,\"note\":\"Person at desk wearing headphones.\"}\n```");

  expect(signals.present).toBe(true);
  expect(signals.headphones).toBe(true);
  expect(signals.note).toBe("Person at desk wearing headphones.");
});
