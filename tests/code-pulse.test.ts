import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { codeVelocity, type CodeSnapshot } from "@/lib/code-velocity";
import { applyCodeDaysToLedger, codeWeekActivity, logCodeFailure, queueCodeDelivery, readCodeDays, readCodePulse, receiveCodeWebhook, reconcileCodePulse, validCodeSignature, type CodeStore } from "@/lib/code-persistence";
import { assembleLedger } from "@/lib/ledger";
import { codePulseAge } from "@/components/CodePulse";
import { fetchCodeSnapshot } from "@/lib/github";
import { GET as scheduled } from "@/app/mirror-api/github/reconcile/route";
import { GET as readRoute } from "@/app/mirror-api/github/route";

const NOW = Date.parse("2026-09-04T20:00:00Z");
const DAY = 86_400_000;
const originalFetch = globalThis.fetch;
const envNames = ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_AUTHOR", "GITHUB_WEBHOOK_SECRET", "CRON_SECRET", "WORK_LIVE_TIME_ZONE"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

function snapshot(now = NOW): CodeSnapshot {
  return {
    from: new Date(now - 35 * DAY).toISOString(), through: new Date(now).toISOString(),
    commits: [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `old-${index}`, at: new Date(now - 10 * DAY).toISOString() })),
      { id: "today", at: new Date(now - 60_000).toISOString() },
    ],
    merges: [], lastCommitAt: new Date(now - 60_000).toISOString(),
  };
}

function memoryStore(): CodeStore {
  let state: Awaited<ReturnType<CodeStore["read"]>>["state"] = { version: 1, snapshot: null, failed: false, attemptedAt: 0, lease: null, deliveries: [], pending: false, days: {} };
  let version = 0;
  return {
    async read() { return { state: structuredClone(state), etag: version ? String(version) : null }; },
    async write(next, etag) {
      if (etag !== (version ? String(version) : null)) return false;
      state = structuredClone(next);
      version++;
      return true;
    },
  };
}

describe("Code Pulse pace and coverage", () => {
  test("last commit displays compact minutes, hours, or days", () => {
    expect(codePulseAge(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
    expect(codePulseAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
    expect(codePulseAge(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe("3h ago");
    expect(codePulseAge(new Date(NOW - 2 * DAY).toISOString(), NOW)).toBe("2d ago");
  });

  test("compares elapsed 7 vs prior28 weekly pace, caps100 and ignores featureDone", () => {
    expect(codeVelocity(snapshot(), NOW).score).toBe(50);
    expect(codeVelocity({ ...snapshot(), merges: [{ id: "pr", at: new Date(NOW - 5000).toISOString() }] }, NOW).score).toBe(100);
    expect(codeVelocity({ ...snapshot(), commits: [...snapshot().commits, ...snapshot().commits] }, NOW).commits).toBe(1);
    const manualFeature = { ...snapshot(), featureDone: true };
    expect(codeVelocity(manualFeature, NOW).score).toBe(50);
    const quiet = snapshot();
    quiet.commits = quiet.commits.slice(0, 8);
    expect(codeVelocity(quiet, NOW).score).toBe(0);
  });

  test("no snapshot, incomplete coverage, and zero baseline never invent a score", () => {
    expect(codeVelocity(null, NOW)).toMatchObject({ commits: null, score: null, status: "unavailable" });
    expect(codeVelocity({ ...snapshot(), from: new Date(NOW - 34 * DAY).toISOString() }, NOW).score).toBeNull();
    expect(codeVelocity({ ...snapshot(), commits: [] }, NOW)).toMatchObject({ commits: 0, score: null, status: "building-baseline" });
  });

  test("exact seven-day boundary belongs to recent, 35-day boundary to baseline", () => {
    const value = { ...snapshot(), commits: [{ id: "a", at: new Date(NOW - 35 * DAY).toISOString() }, { id: "b", at: new Date(NOW - 7 * DAY).toISOString() }] };
    expect(codeVelocity(value, NOW)).toMatchObject({ commits: 1, baselineWeeklyPace: 0.25, score: 100 });
    expect(() => codeVelocity({ ...value, commits: [{ id: "future", at: new Date(NOW).toISOString() }] }, NOW)).toThrow();
  });

  test("failed/stale reads retain exact last verified counts", () => {
    expect(codeVelocity(snapshot(), NOW + 3 * 60 * 60_000)).toMatchObject({ commits: 1, score: 50, freshness: "stale" });
    expect(codeVelocity(snapshot(), NOW, true).freshness).toBe("stale");
  });

  test("week-to-date compares the same elapsed days and refuses incomplete history", () => {
    const days = {
      "2026-08-24": { date: "2026-08-24", commits: 2, merges: 1, lastCommitAt: null },
      "2026-08-25": { date: "2026-08-25", commits: 3, merges: 0, lastCommitAt: null },
      "2026-08-26": { date: "2026-08-26", commits: 4, merges: 1, lastCommitAt: null },
      "2026-08-31": { date: "2026-08-31", commits: 5, merges: 1, lastCommitAt: null },
      "2026-09-01": { date: "2026-09-01", commits: 6, merges: 2, lastCommitAt: null },
      "2026-09-02": { date: "2026-09-02", commits: 7, merges: 1, lastCommitAt: null },
    };
    expect(codeWeekActivity(days, "2026-09-02")).toEqual({
      weekStart: "2026-08-31", through: "2026-09-02", commits: 18, merges: 4,
      comparison: { commits: 9, merges: 2 },
    });
    const { "2026-09-01": _missing, ...incomplete } = days;
    expect(codeWeekActivity(incomplete, "2026-09-02")).toBeNull();
  });
});

describe("durable reconciliation", () => {
  test("structured diagnostics never expose arbitrary upstream text or names", () => {
    const original = console.error;
    const logs: string[] = [];
    console.error = (value) => { logs.push(String(value)); };
    try {
      const error = new Error("GitHub commits request failed (403) Bearer super-secret https://private.example");
      error.name = "super-secret";
      logCodeFailure("fetch", error);
      expect(JSON.parse(logs[0])).toEqual({ component: "code-pulse", stage: "fetch", name: "UnknownError", reason: "operation-failed", status: 403 });
      expect(logs[0]).not.toContain("super-secret");
      expect(logs[0]).not.toContain("private.example");
    } finally { console.error = original; }
  });

  test("Ledger overlay replaces daily and weekly totals once and preserves unrelated values", async () => {
    const data = assembleLedger(["2026-09-04"], new Map(), new Map(), "2026-09-04", "2026-09-04", []);
    const codes = { "2026-09-04": { date: "2026-09-04", commits: 9, merges: 3, lastCommitAt: null } };
    const first = await applyCodeDaysToLedger(data, async () => codes);
    const twice = await applyCodeDaysToLedger(first, async () => codes);
    expect(twice.days[0].commits).toBe(9);
    expect(twice.weeks[0].commits).toBe(9);
    expect(twice.weeks[0].merges).toBe(3);
    expect(twice.days[0].dailyValue).toBe(data.days[0].dailyValue);
    expect(twice.dailyChart).toBe(data.dailyChart);
    expect(data.days[0].commits).toBe(0);
    expect(await applyCodeDaysToLedger(first, async () => { throw new Error("offline"); })).toBe(first);
    expect((await applyCodeDaysToLedger(first, async () => ({}))).days[0].commits).toBe(9);
  });

  test("concurrent deliveries deduplicate and concurrent workers fetch only once", async () => {
    const store = memoryStore();
    expect(await Promise.all([queueCodeDelivery("same", store), queueCodeDelivery("same", store)])).toEqual([true, false]);
    let calls = 0;
    const fetcher = async () => { calls++; return snapshot(); };
    const results = await Promise.all([reconcileCodePulse(store, fetcher, NOW), reconcileCodePulse(store, fetcher, NOW)]);
    expect(results.sort()).toEqual(["busy", "updated"]);
    expect(calls).toBe(1);
    expect(await readCodePulse(store, NOW)).toMatchObject({ score: 50, commits: 1, day: { date: "2026-09-04", commits: 1 } });
    expect(await reconcileCodePulse(store, fetcher, NOW + 1000)).toBe("busy");
  });

  test("failure preserves saved totals, marks stale, and retry repairs", async () => {
    const store = memoryStore();
    await reconcileCodePulse(store, async () => snapshot(), NOW);
    await expect(reconcileCodePulse(store, async () => { throw new Error("secret upstream detail"); }, NOW + 60_001)).rejects.toThrow("saved activity preserved");
    expect(await readCodePulse(store, NOW + 60_001)).toMatchObject({ score: 50, commits: 1, freshness: "stale" });
    await reconcileCodePulse(store, async (now) => snapshot(now), NOW + 120_002);
    expect((await readCodePulse(store, NOW + 120_002)).freshness).toBe("fresh");
  });

  test("an expired worker cannot overwrite its replacement", async () => {
    const store = memoryStore();
    let release!: (value: CodeSnapshot) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = reconcileCodePulse(store, () => { entered(); return new Promise((resolve) => { release = resolve; }); }, NOW);
    await started;
    await reconcileCodePulse(store, async (now) => snapshot(now), NOW + 300_001);
    release(snapshot());
    expect(await first).toBe("busy");
    expect((await readCodePulse(store, NOW + 300_001)).asOf).toBe(new Date(NOW + 300_001).toISOString());
  });

  test("delivery during refresh remains pending and receipt retention is bounded", async () => {
    const store = memoryStore();
    await reconcileCodePulse(store, async () => { await queueCodeDelivery("during", store); return snapshot(); }, NOW);
    expect((await store.read()).state.pending).toBe(true);
    for (let index = 0; index < 260; index++) await queueCodeDelivery(`event-${index}`, store);
    expect((await store.read()).state.deliveries).toHaveLength(256);
  });

  test("today is separate from rolling totals, midnight unsynced is null, archive survives", async () => {
    process.env.WORK_LIVE_TIME_ZONE = "America/Vancouver";
    const store = memoryStore();
    await reconcileCodePulse(store, async () => snapshot(), NOW);
    const midnight = Date.parse("2026-09-05T07:00:00Z");
    expect((await readCodePulse(store, midnight)).day).toBeNull();
    expect((await readCodePulse(store, NOW, "2026-08-25")).day?.commits).toBe(8);
    expect((await readCodePulse(store, NOW, "2026-01-01")).day).toBeNull();
    await reconcileCodePulse(store, async (now) => snapshot(now), NOW + 40 * DAY);
    expect((await readCodeDays("2026-09-04", "2026-09-04", store))["2026-09-04"].commits).toBe(1);
  });

  test("storage failure throws, never returns zero aggregates", async () => {
    const store = memoryStore();
    store.read = async () => { throw new Error("offline"); };
    await expect(readCodePulse(store, NOW)).rejects.toThrow("offline");
  });
});

describe("GitHub boundary", () => {
  test("fetches35days default branch, deduplicates SHAs, preserves older latest commit", async () => {
    process.env.GITHUB_TOKEN = "test-only";
    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_AUTHOR = "owner";
    const urls: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input)); urls.push(url);
      const commit = { sha: "old", commit: { committer: { date: new Date(NOW - 60 * DAY).toISOString() } } };
      return Response.json(url.searchParams.get("per_page") === "1" ? [commit] : []);
    }) as typeof fetch;
    const data = await fetchCodeSnapshot(NOW);
    expect(data.lastCommitAt).toBe(new Date(NOW - 60 * DAY).toISOString());
    expect(Date.parse(data.through) - Date.parse(data.from)).toBe(35 * DAY);
    expect(urls.find((url) => url.searchParams.has("since"))?.searchParams.has("sha")).toBe(false);
  });

  test("malformed GitHub records fail instead of fake zero", async () => {
    process.env.GITHUB_TOKEN = "test-only"; process.env.GITHUB_REPO = "owner/repo"; process.env.GITHUB_AUTHOR = "owner";
    globalThis.fetch = (async () => Response.json([{}])) as unknown as typeof fetch;
    await expect(fetchCodeSnapshot(NOW)).rejects.toThrow();
  });

  test("pagination ceiling fails explicitly rather than saving 10000 partial commits", async () => {
    process.env.GITHUB_TOKEN = "test-only"; process.env.GITHUB_REPO = "owner/repo"; process.env.GITHUB_AUTHOR = "owner";
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      return Response.json(url.pathname.endsWith("commits") && url.searchParams.has("since") ? Array.from({ length: 100 }, () => ({ sha: "a", commit: { committer: { date: new Date(NOW - 1000).toISOString() } } })) : []);
    }) as typeof fetch;
    await expect(fetchCodeSnapshot(NOW)).rejects.toThrow("10000");
  });

  test("backfill paginates beyond1000 commits and counts authored merges only", async () => {
    process.env.GITHUB_TOKEN = "test-only"; process.env.GITHUB_REPO = "owner/repo"; process.env.GITHUB_AUTHOR = "owner";
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const at = new Date(NOW - 1000).toISOString();
      if (url.pathname.endsWith("pulls")) return Response.json([
        { number: 1, merged_at: at, user: { login: "owner" } },
        { number: 2, merged_at: at, user: { login: "other" } },
      ]);
      const page = Number(url.searchParams.get("page") ?? "1");
      const count = url.searchParams.get("per_page") === "1" || page === 11 ? 1 : 100;
      return Response.json(Array.from({ length: count }, (_, index) => ({ sha: `${page}-${index}`, commit: { committer: { date: at } } })));
    }) as typeof fetch;
    const value = await fetchCodeSnapshot(NOW);
    expect(codeVelocity(value, NOW).commits).toBe(1001);
    expect(value.merges).toHaveLength(1);
  });

  test("signature verifies raw bytes and rejects tampering", () => {
    const body = Buffer.from('{"repository":"example"}');
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    expect(validCodeSignature(body, signature, "test-secret")).toBe(true);
    expect(validCodeSignature(Buffer.from("changed"), signature, "test-secret")).toBe(false);
    expect(validCodeSignature(body, "sha256=bad", "test-secret")).toBe(false);
    expect(validCodeSignature(body, signature, undefined)).toBe(false);
  });

  test("webhook persists before scheduling, ignores irrelevant events, rejects foreign repo", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret"; process.env.GITHUB_REPO = "owner/repo";
    const store = memoryStore();
    let scheduledCount = 0;
    const request = (repo = "owner/repo", event = "push") => {
      const body = JSON.stringify({ repository: { full_name: repo } });
      return new Request("https://example.test/mirror-api/github/webhook", { method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}` } });
    };
    const schedule = () => { scheduledCount++; };
    expect((await receiveCodeWebhook(request(), schedule, () => store)).status).toBe(202);
    expect(await (await receiveCodeWebhook(request(), schedule, () => store)).json()).toEqual({ status: "duplicate" });
    expect((await store.read()).state.deliveries).toEqual([createHash("sha256").update(JSON.stringify({ repository: { full_name: "owner/repo" } })).digest("hex")]);
    expect((await receiveCodeWebhook(request("foreign/repo"), schedule, () => store)).status).toBe(403);
    expect((await receiveCodeWebhook(request("owner/repo", "issues"), schedule, () => store)).status).toBe(200);
    expect(scheduledCount).toBe(2);
  });

  test("schedule and read routes fail closed without secrets/storage, validate dates", async () => {
    process.env.CRON_SECRET = "cron-test";
    expect((await scheduled(new Request("https://example.test"))).status).toBe(401);
    expect((await scheduled(new Request("https://example.test", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect((await scheduled(new Request("https://example.test", { headers: { authorization: "Bearer cron-test" } }))).status).toBe(503);
    expect((await readRoute(new Request("https://example.test?day=2026-02-30"))).status).toBe(400);
    expect((await readRoute(new Request("https://example.test"))).status).toBe(503);
  });
});
