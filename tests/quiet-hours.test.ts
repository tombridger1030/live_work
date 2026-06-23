import { expect, test } from "bun:test";
import { isQuietHour, isQuietNow } from "@/lib/time";

test("isQuietHour spans 1am–7am and resumes at 8am", () => {
  expect(isQuietHour(0)).toBe(false); // 12am still shown (working-day edge)
  expect(isQuietHour(1)).toBe(true); // 1am block removed
  expect(isQuietHour(7)).toBe(true); // 7am block removed
  expect(isQuietHour(8)).toBe(false); // capture resumes at 8am (working-day edge)
  expect(isQuietHour(23)).toBe(false);
});

test("isQuietNow evaluates the hour in the given time zone", () => {
  // 10:00 UTC is 03:00 in America/Vancouver (PDT) → inside the quiet window.
  expect(isQuietNow(new Date("2026-06-16T10:00:00Z"), "America/Vancouver")).toBe(true);
  // 16:00 UTC is 09:00 in America/Vancouver → outside it.
  expect(isQuietNow(new Date("2026-06-16T16:00:00Z"), "America/Vancouver")).toBe(false);
});
