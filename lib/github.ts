import { execFile } from "node:child_process";
import { getOptionalEnv, requireEnv } from "@/lib/env";
import { appTimeZone, isValidDayKey } from "@/lib/time";
import { z } from "zod";
import { CODE_WINDOW_DAYS, codeSnapshotSchema, type CodeSnapshot } from "@/lib/code-velocity";

type GitHubActivity = {
  commits: number;
  merges: number;
  lastCommitAt: string | null;
};

type GitHubCommit = {
  commit?: { committer?: { date?: string | null } };
};

type GitHubPullRequest = {
  merged_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string | null } | null;
};

const GITHUB_PAGE_SIZE = 100;
const GITHUB_MAX_PAGES = 10;
const GITHUB_CLI_PATHS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] as const;

function nextDay(dayIso: string): string {
  const at = new Date(`${dayIso}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

function localPartsAt(instant: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return [
    value("year"),
    value("month"),
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  ];
}

function localMidnight(dayIso: string, timeZone: string): Date {
  const [year, month, day] = dayIso.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [localYear, localMonth, localDay, hour, minute, second] = localPartsAt(
      new Date(candidate),
      timeZone,
    );
    const rendered = Date.UTC(
      localYear,
      localMonth - 1,
      localDay,
      hour,
      minute,
      second,
    );
    candidate += target - rendered;
  }
  return new Date(candidate);
}

/** Exact half-open local day, including DST; rejects invalid calendar dates. */
export function githubDayWindow(dayIso: string): { start: Date; end: Date } {
  if (!isValidDayKey(dayIso)) throw new Error("GitHub activity day must be YYYY-MM-DD");
  const timeZone = appTimeZone();
  return {
    start: localMidnight(dayIso, timeZone),
    end: localMidnight(nextDay(dayIso), timeZone),
  };
}

function cliToken(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      ["auth", "token", "--hostname", "github.com"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 8_192 },
      (error, stdout) => {
        const token = stdout.trim();
        if (error || !token) {
          reject(new Error("GitHub CLI is not authenticated"));
          return;
        }
        resolve(token);
      },
    );
  });
}

async function githubToken(): Promise<string> {
  const configured = getOptionalEnv("GITHUB_TOKEN");
  if (configured) {
    return configured;
  }
  if (process.env.VERCEL === "1") {
    throw new Error("GitHub authentication is not configured");
  }
  for (const path of GITHUB_CLI_PATHS) {
    try {
      return await cliToken(path);
    } catch {
      // Try the other fixed Homebrew location before failing closed.
    }
  }
  throw new Error("GitHub CLI is not authenticated; run gh auth login");
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "work-live",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubArray<T>(
  url: URL,
  headers: HeadersInit,
  label: string,
  deadline?: AbortSignal,
): Promise<T[]> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(url, { headers, cache: "no-store", signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout });
  if (!response.ok) {
    throw new Error(`GitHub ${label} request failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`GitHub ${label} returned an invalid response`);
  }
  return body as T[];
}

async function repositoryCommits(
  repo: string,
  author: string,
  start: Date,
  end: Date,
  headers: HeadersInit,
  maxPages = GITHUB_MAX_PAGES,
  deadline?: AbortSignal,
): Promise<GitHubCommit[]> {
  const commits: GitHubCommit[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repo}/commits`);
    url.searchParams.set("author", author);
    url.searchParams.set("since", start.toISOString());
    url.searchParams.set("until", end.toISOString());
    url.searchParams.set("per_page", String(GITHUB_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const batch = await githubArray<GitHubCommit>(url, headers, "commits", deadline);
    commits.push(...batch);
    if (batch.length < GITHUB_PAGE_SIZE) {
      return commits;
    }
  }
  throw new Error(`GitHub commit count exceeds the supported ${maxPages * GITHUB_PAGE_SIZE} window limit`);
}

async function repositoryPullRequests(
  repo: string,
  start: Date,
  headers: HeadersInit,
  maxPages = GITHUB_MAX_PAGES,
  deadline?: AbortSignal,
): Promise<GitHubPullRequest[]> {
  const pullRequests: GitHubPullRequest[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repo}/pulls`);
    url.searchParams.set("state", "closed");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", String(GITHUB_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const batch = await githubArray<GitHubPullRequest>(url, headers, "pull requests", deadline);
    pullRequests.push(...batch);
    const oldestUpdate = batch.at(-1)?.updated_at;
    if (
      batch.length < GITHUB_PAGE_SIZE ||
      (oldestUpdate && new Date(oldestUpdate).getTime() < start.getTime())
    ) {
      return pullRequests;
    }
  }
  throw new Error(`GitHub merge count exceeds the supported ${maxPages * GITHUB_PAGE_SIZE} window limit`);
}

export function isGitHubActivityConfigured(): boolean {
  return Boolean(
    getOptionalEnv("GITHUB_REPO") && getOptionalEnv("GITHUB_AUTHOR"),
  );
}

/**
 * Reads one exact local day's landed commits and authored merged pull requests
 * from the configured private Cortal repository. The token stays server-only:
 * GITHUB_TOKEN wins when deployed, while the self-hosted Mac reads its existing
 * GitHub CLI credential from Keychain. Results cover [local midnight, next local
 * midnight), use the repository's default branch for commits, and throw on auth,
 * API, malformed-config, or >1,000-item failures rather than returning a partial
 * count. No browser-controlled value can select the repository or credential.
 */
export async function fetchCortalActivity(dayIso: string): Promise<GitHubActivity> {
  if (!isValidDayKey(dayIso)) {
    throw new Error("GitHub activity day must be YYYY-MM-DD");
  }
  const repo = requireEnv("GITHUB_REPO");
  const author = requireEnv("GITHUB_AUTHOR");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GITHUB_REPO must be owner/repository");
  }
  if (!/^[A-Za-z0-9-]+$/.test(author)) {
    throw new Error("GITHUB_AUTHOR must be a GitHub login");
  }

  const { start, end } = githubDayWindow(dayIso);
  const headers = githubHeaders(await githubToken());
  const commits = await repositoryCommits(repo, author, start, end, headers);
  const pullRequests = await repositoryPullRequests(repo, start, headers);
  const insideWindow = (iso: string | null | undefined): iso is string => {
    if (!iso) return false;
    const at = new Date(iso).getTime();
    return at >= start.getTime() && at < end.getTime();
  };
  const commitDates = commits
    .map((commit) => commit.commit?.committer?.date)
    .filter(insideWindow)
    .sort((left, right) => right.localeCompare(left));
  const authorLower = author.toLowerCase();
  const merges = pullRequests.filter(
    (pullRequest) =>
      pullRequest.user?.login?.toLowerCase() === authorLower &&
      insideWindow(pullRequest.merged_at),
  ).length;

  return {
    commits: commitDates.length,
    merges,
    lastCommitAt: commitDates[0] ?? null,
  };
}

/**
 * Backfills the full 35 elapsed days in one canonical default-branch query and
 * authored-PR query, with pagination. Throws on partial or malformed responses.
 * `now` is a finite epoch millisecond instant; config and credentials are strictly
 * server-owned. Older latest commits are queried separately so inactivity never
 * erases the last commit date. This does not write Ledger or the Mac snapshot.
 */
export async function fetchCodeSnapshot(now = Date.now()): Promise<CodeSnapshot> {
  if (!Number.isFinite(now)) throw new Error("Invalid observation clock");
  const repo = requireEnv("GITHUB_REPO");
  const author = requireEnv("GITHUB_AUTHOR");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9-]+$/.test(author)) {
    throw new Error("Invalid GitHub activity configuration");
  }
  const end = new Date(now);
  const start = new Date(now - CODE_WINDOW_DAYS * 86_400_000);
  const headers = githubHeaders(await githubToken());
  const latestUrl = new URL(`https://api.github.com/repos/${repo}/commits`);
  const deadline = AbortSignal.timeout(240_000);
  latestUrl.searchParams.set("author", author);
  latestUrl.searchParams.set("until", end.toISOString());
  latestUrl.searchParams.set("per_page", "1");
  const [rawCommits, rawPulls, rawLatest] = await Promise.all([
    repositoryCommits(repo, author, start, end, headers, 100, deadline),
    repositoryPullRequests(repo, start, headers, 100, deadline),
    githubArray(latestUrl, headers, "latest commit", deadline),
  ]);
  const commitSchema = z.object({ sha: z.string().min(1), commit: z.object({ committer: z.object({ date: z.string().datetime({ offset: true }) }) }) });
  const pulls = z.array(z.object({ number: z.number().int().positive(), merged_at: z.string().datetime({ offset: true }).nullable(), user: z.object({ login: z.string() }) })).parse(rawPulls);
  const commits = z.array(commitSchema).parse(rawCommits);
  const latest = z.array(commitSchema).parse(rawLatest);
  const inside = (at: string) => Date.parse(at) >= start.getTime() && Date.parse(at) < now;
  return codeSnapshotSchema.parse({
    from: start.toISOString(), through: end.toISOString(),
    commits: commits.filter((commit) => inside(commit.commit.committer.date)).map((commit) => ({ id: commit.sha, at: commit.commit.committer.date })),
    merges: pulls.filter((pr) => pr.user.login.toLowerCase() === author.toLowerCase() && pr.merged_at && inside(pr.merged_at)).map((pr) => ({ id: String(pr.number), at: pr.merged_at })),
    lastCommitAt: [...commits, ...latest].map((commit) => commit.commit.committer.date).filter((at) => Date.parse(at) < now).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
  });
}
