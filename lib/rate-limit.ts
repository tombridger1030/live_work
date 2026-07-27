import { getOptionalEnv } from "@/lib/env";
import { sql } from "@/lib/sql";

type Bucket = {
  windowStart: number;
  hits: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds?: number;
};

const HOUR_MS = 60 * 60 * 1000;

// One fixed-window implementation for the in-memory limiters, so window
// semantics can't drift between capture and feedback.
function checkHourlyBudget(store: Map<string, Bucket>, key: string, limit: number, now: number): RateLimitResult {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true };
  }

  const existing = store.get(key);
  if (!existing || now - existing.windowStart >= HOUR_MS) {
    store.set(key, { windowStart: now, hits: 1 });
    return { allowed: true };
  }

  if (existing.hits >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((existing.windowStart + HOUR_MS - now) / 1000)
    };
  }

  existing.hits += 1;
  return { allowed: true };
}

export function checkCaptureRateLimit(key: string, now = Date.now()): RateLimitResult {
  return checkHourlyBudget(buckets, key, Number(process.env.CAPTURE_RATE_LIMIT_PER_HOUR || 6), now);
}

const feedbackBuckets = new Map<string, Bucket>();

/**
 * Bounds signal corrections. Defence in depth: the route is owner-authenticated,
 * so this exists to cap the damage a stolen session cookie could do to the public
 * accountability record and to the `human_verified` rows the eval and the
 * vision-model benchmark treat as ground truth. Deliberately keyed by a CONSTANT
 * rather than client IP — an attacker holding the cookie can rotate IPs, so a
 * per-IP budget would not bound anything. Sized for a real review session
 * (dozens of corrections), not bulk rewriting.
 */
export function checkFeedbackRateLimit(now = Date.now()): RateLimitResult {
  return checkHourlyBudget(
    feedbackBuckets,
    "feedback:owner",
    Number(process.env.WORK_LIVE_FEEDBACK_RATE_LIMIT_PER_HOUR || 120),
    now
  );
}

const OWNER_SESSION_WINDOW_MS = 15 * 60 * 1000;
const OWNER_SESSION_LIMIT = 5;
const ownerSessionBuckets = new Map<string, Bucket>();
let ownerSessionSchemaReady = false;

export class RateLimitUnavailableError extends Error {
  constructor() {
    super("Shared owner-session rate limit storage is unavailable");
    this.name = "RateLimitUnavailableError";
  }
}

function hasPostgresConfig(): boolean {
  return Boolean(
    getOptionalEnv("WORK_LIVE_POSTGRES_URL") ||
    getOptionalEnv("POSTGRES_URL") ||
      getOptionalEnv("POSTGRES_PRISMA_URL") ||
      getOptionalEnv("POSTGRES_URL_NON_POOLING") ||
      getOptionalEnv("POSTGRES_HOST")
  );
}

function checkLocalOwnerSessionRateLimit(key: string, now: number): RateLimitResult {
  const existing = ownerSessionBuckets.get(key);
  if (!existing || now - existing.windowStart >= OWNER_SESSION_WINDOW_MS) {
    ownerSessionBuckets.set(key, { windowStart: now, hits: 1 });
    return { allowed: true };
  }
  if (existing.hits >= OWNER_SESSION_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((existing.windowStart + OWNER_SESSION_WINDOW_MS - now) / 1000)
    };
  }
  existing.hits += 1;
  return { allowed: true };
}

/**
 * Checks the owner-session attempt budget.
 *
 * Shared (Postgres) storage is required only where requests fan out across
 * instances: its upsert locks one key row, so concurrent serverless invocations
 * share one atomic five-attempt window. A single self-hosted process has ONE
 * memory space, so the in-process limiter genuinely bounds attempts there.
 *
 * Failure semantics: throws RateLimitUnavailableError only on serverless without
 * shared storage. Self-host used to hit that path too (NODE_ENV=production with
 * no Postgres), which locked the owner out of their own ledger with a 503.
 */
export async function checkOwnerSessionRateLimit(key: string, now = Date.now()): Promise<RateLimitResult> {
  if (!hasPostgresConfig()) {
    // `VERCEL` marks the multi-instance serverless deployment, where an
    // in-memory counter cannot bound attempts across instances and failing
    // closed is the honest choice. A single self-hosted process is not that.
    if (getOptionalEnv("VERCEL")) {
      throw new RateLimitUnavailableError();
    }
    return checkLocalOwnerSessionRateLimit(key, now);
  }

  if (!ownerSessionSchemaReady) {
    await sql`
      CREATE TABLE IF NOT EXISTS owner_session_rate_limits (
        rate_key TEXT PRIMARY KEY,
        window_start_ms BIGINT NOT NULL,
        hits INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS owner_session_rate_limits_updated_at_idx
        ON owner_session_rate_limits (updated_at)
    `;
    ownerSessionSchemaReady = true;
  }

  // This endpoint is low-volume, so run the indexed TTL cleanup on every
  // attempt instead of relying on process-local cleanup state that cold starts
  // would reset on every Vercel instance.
  await sql`
    DELETE FROM owner_session_rate_limits
    WHERE updated_at < now() - INTERVAL '1 hour'
  `;

  const windowStart = now - (now % OWNER_SESSION_WINDOW_MS);
  const result = await sql`
    INSERT INTO owner_session_rate_limits (rate_key, window_start_ms, hits, updated_at)
    VALUES (${key}, ${windowStart}, 1, now())
    ON CONFLICT (rate_key) DO UPDATE SET
      window_start_ms = EXCLUDED.window_start_ms,
      hits = CASE
        WHEN owner_session_rate_limits.window_start_ms = EXCLUDED.window_start_ms
          THEN owner_session_rate_limits.hits + 1
        ELSE 1
      END,
      updated_at = now()
    RETURNING window_start_ms, hits
  `;
  const row = result.rows[0] as { window_start_ms: number | string; hits: number | string };
  const hits = Number(row.hits);
  if (hits > OWNER_SESSION_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((windowStart + OWNER_SESSION_WINDOW_MS - now) / 1000)
    };
  }
  return { allowed: true };
}
