import { expect, test } from "bun:test";
import { parseSignals } from "@/lib/vision";

test("defaults an empty note instead of rejecting the frame", () => {
  const signals = parseSignals('{"headphones":false,"note":""}');
  expect(signals.note.length).toBeGreaterThan(0);
  expect(signals.headphones).toBe(false);
  expect(signals.present).toBe(true);
});

test("clamps an over-long note to the 160-char cap", () => {
  const longNote = "x".repeat(400);
  const signals = parseSignals(`{"headphones":true,"note":"${longNote}"}`);
  expect(signals.note.length).toBe(160);
  expect(signals.headphones).toBe(true);
});

test("passes a clean, valid reply through with placeholder legacy fields", () => {
  const signals = parseSignals('{"headphones":true,"note":"Wearing headphones at desk."}');
  expect(signals).toEqual({
    present: true,
    headphones: true,
    eyesOnScreen: false,
    posture: "unknown",
    note: "Wearing headphones at desk."
  });
});

test("tolerates a markdown code fence around the JSON", () => {
  const signals = parseSignals('```json\n{"headphones":false,"note":"ok"}\n```');
  expect(signals.present).toBe(true);
  expect(signals.headphones).toBe(false);
});

test("still rejects a reply missing headphones", () => {
  expect(() => parseSignals('{"note":"no headphones key"}')).toThrow();
});

test("still rejects non-JSON content", () => {
  expect(() => parseSignals("the model said no")).toThrow();
});
