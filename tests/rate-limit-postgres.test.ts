import { expect, mock, test } from "bun:test";
import { createOwnerSessionToken, OWNER_SESSION_COOKIE } from "@/lib/auth";
import { localDayKey } from "@/lib/time";

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
    return;
  }
  Object.defineProperty(process.env, "NODE_ENV", { value, writable: true, configurable: true, enumerable: true });
}

const rows = new Map<string, { windowStart: number; hits: number }>();
let failLedgerMutation = false;
const queries: string[] = [];
const sql = mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?");
  queries.push(query);
  if (failLedgerMutation && query.includes("INSERT INTO scoreboard_entries")) {
    throw new Error("simulated database failure");
  }
  if (query.includes("INSERT INTO owner_session_rate_limits")) {
    const key = String(values[0]);
    const windowStart = Number(values[1]);
    const existing = rows.get(key);
    const hits = existing && existing.windowStart === windowStart ? existing.hits + 1 : 1;
    rows.set(key, { windowStart, hits });
    return { rows: [{ window_start_ms: windowStart, hits }] };
  }
  return { rows: [] };
});

mock.module("@vercel/postgres", () => ({ sql }));
const { checkOwnerSessionRateLimit } = await import("@/lib/rate-limit");
// Dynamic import is required here so the mocked Postgres module is installed
// before the routes import the adapters they exercise.
const { POST: ownerSessionPost } = await import("@/app/api/ledger/session/route");
const { POST: ledgerPost } = await import("@/app/api/ledger/route");

test("shared owner limiter enforces five attempts, rollover, and bounded cleanup", async () => {
  const previousPostgresUrl = process.env.POSTGRES_URL;
  try {
    process.env.POSTGRES_URL = "mock-postgres";
    const now = Date.UTC(2026, 6, 21, 12);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await checkOwnerSessionRateLimit("shared-probe", now)).toEqual({ allowed: true });
    }
    expect((await checkOwnerSessionRateLimit("shared-probe", now)).allowed).toBe(false);
    expect((await checkOwnerSessionRateLimit("shared-probe", now + 15 * 60 * 1000)).allowed).toBe(true);
    expect(queries.some((query) => query.includes("CREATE TABLE IF NOT EXISTS owner_session_rate_limits"))).toBe(true);
    expect(queries.some((query) => query.includes("CREATE INDEX IF NOT EXISTS owner_session_rate_limits_updated_at_idx"))).toBe(true);
    expect(queries.some((query) => query.includes("DELETE FROM owner_session_rate_limits"))).toBe(true);
    const atomicUpsert = queries.find((query) => query.includes("INSERT INTO owner_session_rate_limits")) ?? "";
    expect(atomicUpsert).toContain("ON CONFLICT (rate_key) DO UPDATE SET");
    expect(atomicUpsert).toContain("owner_session_rate_limits.hits + 1");
    expect(atomicUpsert).toContain("EXCLUDED.window_start_ms");
  } finally {
    if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousPostgresUrl;
  }
});

test("production-like limiter fails closed when shared storage is missing", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPostgresUrl = process.env.POSTGRES_URL;
  try {
    delete process.env.POSTGRES_URL;
    setNodeEnv("production");
    await expect(checkOwnerSessionRateLimit("missing-storage", Date.now())).rejects.toThrow("Shared owner-session rate limit storage is unavailable");
  } finally {
    setNodeEnv(previousNodeEnv);
    if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousPostgresUrl;
  }
});

test("owner-session route maps unavailable, throttled, and accepted outcomes", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const previousOwnerSecret = process.env.OWNER_SECRET;
  try {
    setNodeEnv("production");
    process.env.OWNER_SECRET = "route-owner-secret";
    delete process.env.POSTGRES_URL;

    const unavailable = await ownerSessionPost(
      new Request("https://example.test/api/ledger/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.10" },
        body: JSON.stringify({ secret: "route-owner-secret" })
      })
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("set-cookie")).toBeNull();

    process.env.POSTGRES_URL = "mock-postgres";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejectedSecret = await ownerSessionPost(
        new Request("https://example.test/api/ledger/session", {
          method: "POST",
          headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.11" },
          body: JSON.stringify({ secret: "wrong-secret" })
        })
      );
      expect(rejectedSecret.status).toBe(401);
    }
    const throttled = await ownerSessionPost(
      new Request("https://example.test/api/ledger/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.11" },
        body: JSON.stringify({ secret: "wrong-secret" })
      })
    );
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);

    const accepted = await ownerSessionPost(
      new Request("https://example.test/api/ledger/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.12" },
        body: JSON.stringify({ secret: "route-owner-secret" })
      })
    );
    const cookie = accepted.headers.get("set-cookie") ?? "";
    expect(accepted.status).toBe(200);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
  } finally {
    setNodeEnv(previousNodeEnv);
    if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousPostgresUrl;
    if (previousOwnerSecret === undefined) delete process.env.OWNER_SECRET;
    else process.env.OWNER_SECRET = previousOwnerSecret;
  }
});

test("ledger route distinguishes malformed JSON from mutation failures", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPostgresUrl = process.env.POSTGRES_URL;
  const previousOwnerSecret = process.env.OWNER_SECRET;
  const secret = "ledger-route-owner-secret";
  try {
    setNodeEnv("test");
    process.env.POSTGRES_URL = "mock-postgres";
    process.env.OWNER_SECRET = secret;
    const cookie = `${OWNER_SESSION_COOKIE}=${createOwnerSessionToken(secret)}`;
    const headers = { cookie, "content-type": "application/json" };

    const malformed = await ledgerPost(
      new Request("https://example.test/api/ledger", {
        method: "POST",
        headers,
        body: "{"
      })
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Invalid JSON" });
    const impossibleDay = await ledgerPost(
      new Request("https://example.test/api/ledger", {
        method: "POST",
        headers,
        body: JSON.stringify({ day: "2026-02-30", reachouts: 1 })
      })
    );
    expect(impossibleDay.status).toBe(400);
    expect(await impossibleDay.json()).toEqual({ error: "day must be YYYY-MM-DD" });

    failLedgerMutation = true;
    const failedMutation = await ledgerPost(
      new Request("https://example.test/api/ledger", {
        method: "POST",
        headers,
        body: JSON.stringify({ day: localDayKey(new Date()), reachouts: 1 })
      })
    );
    expect(failedMutation.status).toBe(500);
    expect(await failedMutation.json()).toEqual({ error: "Unable to save ledger change" });
  } finally {
    failLedgerMutation = false;
    setNodeEnv(previousNodeEnv);
    if (previousPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previousPostgresUrl;
    if (previousOwnerSecret === undefined) delete process.env.OWNER_SECRET;
    else process.env.OWNER_SECRET = previousOwnerSecret;
  }
});
