import { getOptionalEnv, isProductionLike } from "@/lib/env";
import { sql } from "@vercel/postgres";

type Bucket = {
  windowStart: number;
  hits: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds?: number;
};

export function checkCaptureRateLimit(key: string, now = Date.now()): RateLimitResult {
  const limit = Number(process.env.CAPTURE_RATE_LIMIT_PER_HOUR || 6);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true };
  }

  const hourMs = 60 * 60 * 1000;
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= hourMs) {
    buckets.set(key, { windowStart: now, hits: 1 });
    return { allowed: true };
  }

  if (existing.hits >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((existing.windowStart + hourMs - now) / 1000)
    };
  }

  existing.hits += 1;
  return { allowed: true };
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
 * Checks the owner-session attempt budget. Production-like deployments fail
 * closed without Postgres; local process memory is only a development fallback.
 * The Postgres upsert locks one key row, so concurrent instances share one
 * atomic five-attempt window.
 */
export async function checkOwnerSessionRateLimit(key: string, now = Date.now()): Promise<RateLimitResult> {
  if (!hasPostgresConfig()) {
    if (isProductionLike()) {
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
