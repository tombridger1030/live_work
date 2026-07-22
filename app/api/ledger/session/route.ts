import { createOwnerSessionToken, isOwnerSecret, OWNER_SESSION_COOKIE, OWNER_SESSION_MAX_AGE_SECONDS, jsonError } from "@/lib/auth";
import { getOptionalEnv, isProductionLike } from "@/lib/env";
import { checkOwnerSessionRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Exchanges the owner secret for a short-lived signed httpOnly cookie. The
 * browser sends the secret only in this HTTPS request; client code never stores
 * or receives it after verification.
 */
export async function POST(request: Request): Promise<Response> {
  const vercelForwardedFor = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientKey = vercelForwardedFor || forwardedFor || request.headers.get("x-real-ip")?.trim() || "unknown";
  let rateLimit;
  try {
    rateLimit = await checkOwnerSessionRateLimit(`owner-session:${clientKey}`);
  } catch (error) {
    console.error("[ledger/session] rate-limit check failed", error);
    return jsonError("Rate limit service unavailable", 503);
  }
  if (!rateLimit.allowed) {
    const response = jsonError("Too many attempts", 429);
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds ?? 900));
    return response;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const suppliedSecret = typeof body === "object" && body !== null && "secret" in body && typeof body.secret === "string" ? body.secret : null;
  if (!isOwnerSecret(suppliedSecret, getOptionalEnv("OWNER_SECRET"))) {
    return jsonError("Unauthorized", 401);
  }

  const token = createOwnerSessionToken(getOptionalEnv("OWNER_SECRET") as string);
  const secure = isProductionLike() ? "; Secure" : "";
  const response = Response.json({ ok: true });
  response.headers.set(
    "Set-Cookie",
    `${OWNER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${OWNER_SESSION_MAX_AGE_SECONDS}${secure}`
  );
  return response;
}
