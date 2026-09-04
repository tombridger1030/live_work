import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchCortalActivity } from "@/lib/github";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchCortalActivity", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token-never-sent";
    process.env.GITHUB_REPO = "tombridger1030/platform";
    process.env.GITHUB_AUTHOR = "tombridger1030";
    process.env.WORK_LIVE_TIME_ZONE = "America/Vancouver";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_AUTHOR;
  });

  test("counts a full local day and paginates beyond 100 commits", async () => {
    const seen: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      seen.push(url);
      if (url.pathname.endsWith("/commits")) {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) {
          return jsonResponse(
            Array.from({ length: 100 }, () => ({
              commit: { committer: { date: "2026-08-24T18:00:00Z" } },
            })),
          );
        }
        return jsonResponse([
          { commit: { committer: { date: "2026-08-25T06:59:00Z" } } },
        ]);
      }
      return jsonResponse([
        {
          user: { login: "tombridger1030" },
          merged_at: "2026-08-25T06:30:00Z",
          updated_at: "2026-08-25T06:30:00Z",
        },
        {
          user: { login: "someone-else" },
          merged_at: "2026-08-24T20:00:00Z",
          updated_at: "2026-08-24T20:00:00Z",
        },
        {
          user: { login: "tombridger1030" },
          merged_at: "2026-08-25T07:00:00Z",
          updated_at: "2026-08-25T07:00:00Z",
        },
      ]);
    }) as typeof fetch;

    const activity = await fetchCortalActivity("2026-08-24");

    expect(activity).toEqual({
      commits: 101,
      merges: 1,
      lastCommitAt: "2026-08-25T06:59:00Z",
    });
    const commitsUrl = seen.find((url) => url.pathname.endsWith("/commits"));
    expect(commitsUrl?.searchParams.get("since")).toBe("2026-08-24T07:00:00.000Z");
    expect(commitsUrl?.searchParams.get("until")).toBe("2026-08-25T07:00:00.000Z");
    expect(seen.filter((url) => url.pathname.endsWith("/commits"))).toHaveLength(2);
  });

  test("uses a 25-hour window across Vancouver's 2025 fall DST boundary", async () => {
    const seen: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      seen.push(url);
      return jsonResponse([]);
    }) as typeof fetch;

    await fetchCortalActivity("2025-11-02");

    const commitsUrl = seen.find((url) => url.pathname.endsWith("/commits"));
    expect(commitsUrl?.searchParams.get("since")).toBe("2025-11-02T07:00:00.000Z");
    expect(commitsUrl?.searchParams.get("until")).toBe("2025-11-03T08:00:00.000Z");
  });

  test("rejects an invalid day before contacting GitHub", async () => {
    let called = false;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      called = true;
      return jsonResponse([]);
    }) as typeof fetch;

    await expect(fetchCortalActivity("2026-02-30")).rejects.toThrow(
      "GitHub activity day must be YYYY-MM-DD",
    );
    expect(called).toBe(false);
  });
});
