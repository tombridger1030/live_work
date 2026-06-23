import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { POST } from "@/app/api/critical/route";
import { hourlyForDay, saveHourlyCheckin, setCriticalHour } from "@/lib/store";
import type { HourlyCheckin } from "@/lib/types";

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

const day = "2026-06-20";
const hour = 10;

function baseCheckin(): HourlyCheckin {
  return { day, hour, avgScore: 70, presentPct: 100, headphonesPct: 50, verdict: "At desk", critical: false };
}

function postCritical(body: unknown): Promise<Response> {
  return POST(new Request("http://test.local/api/critical", { method: "POST", body: JSON.stringify(body) }));
}

test("setCriticalHour marks an existing hour and rollups preserve the human flag", async () => {
  const checkin = baseCheckin();

  await saveHourlyCheckin(checkin);
  expect(await setCriticalHour(day, hour, true)).toMatchObject({ critical: true });

  await saveHourlyCheckin({ ...checkin, avgScore: 95, verdict: "Locked in" });

  expect(await hourlyForDay(day)).toEqual([{ ...checkin, avgScore: 95, verdict: "Locked in", critical: true }]);
});

test("setCriticalHour returns null when no captured hour exists", async () => {
  expect(await setCriticalHour(day, hour, true)).toBeNull();
});

test("critical route validates input before writing", async () => {
  const response = await postCritical({ day: "2026-6-20", hour, critical: true });

  expect(response.status).toBe(400);
});

test("critical route marks an existing hour", async () => {
  await saveHourlyCheckin(baseCheckin());

  const response = await postCritical({ day, hour, critical: true });
  const body = (await response.json()) as { checkin: HourlyCheckin };

  expect(response.status).toBe(200);
  expect(body.checkin.critical).toBe(true);
  expect((await hourlyForDay(day))[0].critical).toBe(true);
});
