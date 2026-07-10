import { requireEnv } from "@/lib/env";

type CommitSearch = { total_count?: number; items?: { commit?: { committer?: { date?: string } } }[] };
type IssueSearch = { total_count?: number };

/**
 * Counts the owner's commits and merged PRs to the build repo on `dayIso` and
 * returns the most recent commit timestamp (used to suppress the "wandered off"
 * nudge while code is actively landing).
 *
 * `dayIso` is a local YYYY-MM-DD used as a date-only `>=` lower bound, so a few
 * hours of prior-UTC-day fuzz is possible and accepted (see plan). Repo, author,
 * and token come from GITHUB_REPO / GITHUB_AUTHOR / GITHUB_TOKEN — missing env
 * throws so a misconfigured deploy fails loudly. Throws on any non-2xx; the cron
 * evaluator treats a failure as non-fatal (commits stay at their last value).
 */
export async function fetchCortalActivity(
  dayIso: string
): Promise<{ commits: number; merges: number; lastCommitAt: string | null }> {
  const headers = {
    Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "work-live"
  };
  const repo = requireEnv("GITHUB_REPO");
  const author = requireEnv("GITHUB_AUTHOR");

  const commitsQuery = encodeURIComponent(`repo:${repo} author:${author} committer-date:>=${dayIso}`);
  const commitsResponse = await fetch(
    `https://api.github.com/search/commits?q=${commitsQuery}&sort=committer-date&order=desc&per_page=1`,
    { headers }
  );
  if (!commitsResponse.ok) {
    throw new Error(`GitHub search/commits failed: ${commitsResponse.status} ${await commitsResponse.text().catch(() => "")}`.trim());
  }
  const commitsBody = (await commitsResponse.json()) as CommitSearch;
  const commits = Number(commitsBody.total_count ?? 0);
  const lastCommitAt = commitsBody.items?.[0]?.commit?.committer?.date ?? null;

  const mergesQuery = encodeURIComponent(`repo:${repo} is:pr is:merged author:${author} merged:>=${dayIso}`);
  const mergesResponse = await fetch(`https://api.github.com/search/issues?q=${mergesQuery}&per_page=1`, { headers });
  if (!mergesResponse.ok) {
    throw new Error(`GitHub search/issues failed: ${mergesResponse.status} ${await mergesResponse.text().catch(() => "")}`.trim());
  }
  const mergesBody = (await mergesResponse.json()) as IssueSearch;
  const merges = Number(mergesBody.total_count ?? 0);

  return { commits, merges, lastCommitAt };
}
