import { describe, expect, test } from "bun:test";
import { parseSnoozeVerdict, type SnoozeVerdict } from "@/lib/accountability";

describe("parseSnoozeVerdict", () => {
  // 1. Valid grant JSON -> correct action/minutes/message
  test("parses valid grant JSON correctly", () => {
    const input = '{"action":"grant","minutes":45,"message":"ok"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(45);
    expect(result.message).toBe("ok");
  });

  test("parses valid challenge JSON correctly", () => {
    const input = '{"action":"challenge","minutes":0,"message":"push back"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("challenge");
    expect(result.minutes).toBe(0);
    expect(result.message).toBe("push back");
  });

  // 2. Minutes clamping: 999 -> 240; -5 -> 0; 30.7 -> 31 (rounded)
  test("clamps grant minutes to max 240", () => {
    const input = '{"action":"grant","minutes":999,"message":"test"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(240);
  });

  test("clamps negative grant minutes to 0", () => {
    const input = '{"action":"grant","minutes":-5,"message":"test"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(0);
  });

  test("rounds fractional grant minutes", () => {
    const input = '{"action":"grant","minutes":30.7,"message":"test"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(31);
  });

  // 3. Challenge forces minutes to 0 even when JSON provides nonzero
  test("challenge forces minutes to 0 even with nonzero in JSON", () => {
    const input = '{"action":"challenge","minutes":50,"message":"test"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("challenge");
    expect(result.minutes).toBe(0);
  });

  // 4. Unknown action -> "challenge"; empty object {} -> "challenge" with minutes 0
  test("coerces unknown action to challenge", () => {
    const input = '{"action":"maybe","minutes":30,"message":"test"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("challenge");
    expect(result.minutes).toBe(0);
  });

  test("handles empty object as challenge with minutes 0", () => {
    const input = "{}";
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("challenge");
    expect(result.minutes).toBe(0);
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("coerces missing action to challenge", () => {
    const input = '{"minutes":30,"message":"test"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("challenge");
    expect(result.minutes).toBe(0);
  });

  // 5. Fenced/prose-wrapped JSON still parses
  test("parses JSON with markdown code fence", () => {
    const input = '```json\n{"action":"grant","minutes":45,"message":"ok"}\n```';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(45);
    expect(result.message).toBe("ok");
  });

  test("parses JSON with plain code fence", () => {
    const input = '```\n{"action":"grant","minutes":30,"message":"test"}\n```';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(30);
    expect(result.message).toBe("test");
  });

  test("parses JSON with prose prefix", () => {
    const input = 'sure: {"action":"grant","minutes":60,"message":"gym"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(60);
    expect(result.message).toBe("gym");
  });

  test("parses JSON with prose suffix", () => {
    const input = '{"action":"grant","minutes":90,"message":"jj"} sounds good';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(90);
    expect(result.message).toBe("jj");
  });

  // 6. Missing/blank message -> non-empty fallback message (assert length > 0)
  test("grant with missing message gets non-empty fallback", () => {
    const input = '{"action":"grant","minutes":30}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(30);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("30"); // Should mention the minutes
  });

  test("grant with blank message gets non-empty fallback", () => {
    const input = '{"action":"grant","minutes":45,"message":""}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(45);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("45");
  });

  test("grant with whitespace-only message gets non-empty fallback", () => {
    const input = '{"action":"grant","minutes":20,"message":"   "}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("grant");
    expect(result.minutes).toBe(20);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("20");
  });

  test("challenge with missing message gets non-empty fallback", () => {
    const input = '{"action":"challenge"}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("challenge");
    expect(result.minutes).toBe(0);
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("challenge with blank message gets non-empty fallback", () => {
    const input = '{"action":"challenge","minutes":0,"message":""}';
    const result = parseSnoozeVerdict(input);
    expect(result.action).toBe("challenge");
    expect(result.minutes).toBe(0);
    expect(result.message.length).toBeGreaterThan(0);
  });

  // 7. Throws on "" (empty) and on "hello" (no JSON object)
  test("throws on empty string", () => {
    expect(() => parseSnoozeVerdict("")).toThrow();
  });

  test("throws on whitespace-only input", () => {
    expect(() => parseSnoozeVerdict("   ")).toThrow();
  });

  test("throws on null", () => {
    expect(() => parseSnoozeVerdict(null)).toThrow();
  });

  test("throws on undefined", () => {
    expect(() => parseSnoozeVerdict(undefined)).toThrow();
  });

  test("throws on text with no JSON object", () => {
    expect(() => parseSnoozeVerdict("hello")).toThrow();
  });

  test("throws on text that looks like JSON but is not an object", () => {
    expect(() => parseSnoozeVerdict("just some text without braces")).toThrow();
  });
});
