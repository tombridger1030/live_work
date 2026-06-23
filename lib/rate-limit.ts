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
