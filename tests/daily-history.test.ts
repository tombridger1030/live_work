import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { dailyHistory, saveHourlyCheckin } from "@/lib/store";
import type { HourlyCheckin } from "@/lib/types";

// Force the local-store branch regardless of any ambient Postgres config, and
// start each test from an empty local store so prior data never leaks in.
async function resetStore() {
  await rm(path.join(process.cwd(), ".work-live"), { recursive: true, force: true });
}

beforeEach(async () => {
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  delete process.env.POSTGRES_URL_NON_POOLING;
  delete process.env.POSTGRES_HOST;
  await resetStore();
});

afterEach(resetStore);

function checkin(day: string, hour: number, avgScore: number, presentPct: number): HourlyCheckin {
  return { day, hour, avgScore, presentPct, headphonesPct: 0, verdict: "", critical: false };
}

test("dailyHistory averages each day's hourly check-ins, newest first", async () => {
  await saveHourlyCheckin(checkin("2026-06-13", 9, 50, 40));
  await saveHourlyCheckin(checkin("2026-06-14", 9, 80, 100));
  await saveHourlyCheckin(checkin("2026-06-14", 10, 90, 80));

  const history = await dailyHistory(10);

  expect(history.map((entry) => entry.day)).toEqual(["2026-06-14", "2026-06-13"]);
  expect(history[0]).toEqual({ day: "2026-06-14", avgScore: 85, presentPct: 90, hours: 2 });
  expect(history[1]).toEqual({ day: "2026-06-13", avgScore: 50, presentPct: 40, hours: 1 });
});

test("dailyHistory caps results at the requested limit, keeping the most recent days", async () => {
  for (const day of ["2026-06-10", "2026-06-11", "2026-06-12"]) {
    await saveHourlyCheckin(checkin(day, 9, 70, 70));
  }

  const history = await dailyHistory(2);

  expect(history.map((entry) => entry.day)).toEqual(["2026-06-12", "2026-06-11"]);
});

test("dailyHistory only counts the 8am-11pm scoring window", async () => {
  await saveHourlyCheckin(checkin("2026-06-14", 1, 90, 100)); // 1am — excluded
  await saveHourlyCheckin(checkin("2026-06-14", 7, 90, 100)); // 7am — excluded
  await saveHourlyCheckin(checkin("2026-06-14", 8, 8, 0)); // 8am — counts (away)
  await saveHourlyCheckin(checkin("2026-06-14", 22, 60, 80)); // 10pm — counts
  await saveHourlyCheckin(checkin("2026-06-14", 23, 90, 100)); // 11pm — excluded

  const history = await dailyHistory(10);

  // Only hours 8 and 22 count: avg (8+60)/2 = 34, present (0+80)/2 = 40, 2 hours.
  expect(history[0]).toEqual({ day: "2026-06-14", avgScore: 34, presentPct: 40, hours: 2 });
});

test("dailyHistory omits days whose only check-ins fall outside the scoring window", async () => {
  await saveHourlyCheckin(checkin("2026-06-14", 3, 90, 100)); // overnight only

  expect(await dailyHistory(10)).toEqual([]);
});
