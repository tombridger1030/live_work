import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function isBearerAuthorized(request: Request, secret: string | null): boolean {
  if (!secret) {
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && typeof token === "string" && safeEqual(token, secret);
}

export const OWNER_SESSION_COOKIE = "work_live_owner";
export const OWNER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function isOwnerSecret(value: string | null, secret: string | null): boolean {
  if (!value || !secret) {
    return false;
  }
  return safeEqual(value, secret);
}

function ownerSessionSignature(issuedAt: string, secret: string): string {
  return createHmac("sha256", secret).update(`work-live-owner:${issuedAt}`).digest("hex");
}

export function createOwnerSessionToken(secret: string, now = Date.now()): string {
  const issuedAt = String(Math.floor(now / 1000));
  return `${issuedAt}.${ownerSessionSignature(issuedAt, secret)}`;
}

/**
 * Checks the signed owner cookie used by browser-originated owner mutations.
 * The cookie contains only an issuance timestamp and an HMAC, never the owner
 * secret. It is valid for `OWNER_SESSION_MAX_AGE_SECONDS` and fails closed when
 * the secret is missing or rotated.
 */
export function isOwnerSessionAuthorized(request: Request, secret: string | null, now = Date.now()): boolean {
  if (!secret) {
    return false;
  }
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OWNER_SESSION_COOKIE}=`))
    ?.slice(OWNER_SESSION_COOKIE.length + 1);
  if (!cookie) {
    return false;
  }
  const [issuedAt, signature] = cookie.split(".");
  const issuedSeconds = Number(issuedAt);
  if (!issuedAt || !signature || !Number.isInteger(issuedSeconds)) {
    return false;
  }
  const age = Math.floor(now / 1000) - issuedSeconds;
  if (age < 0 || age > OWNER_SESSION_MAX_AGE_SECONDS) {
    return false;
  }
  return safeEqual(signature, ownerSessionSignature(issuedAt, secret));
}

/**
 * Authorizes one browser-originated owner mutation.
 *
 * Preconditions: production Next listens only on localhost behind Tailscale
 * Serve, which owns the forwarded host/protocol headers and strips any
 * client-supplied `Tailscale-User-Login` header before adding its verified
 * tailnet identity. Postconditions: the request is accepted only from its
 * externally visible browser origin and with either that verified identity or
 * a valid signed owner-session cookie. Requests with no Origin fail closed.
 */
export function isOwnerMutationAuthorized(
  request: Request,
  secret: string | null,
  now = Date.now(),
): boolean {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  let browserOrigin = new URL(request.url).origin;
  if (forwardedHost || forwardedProtocol) {
    if (!forwardedHost || !forwardedProtocol || !["http", "https"].includes(forwardedProtocol)) {
      return false;
    }
    browserOrigin = new URL(`${forwardedProtocol}://${forwardedHost}`).origin;
  }
  if (!origin || origin !== browserOrigin) {
    return false;
  }
  // Only the loopback Mac server sits behind trusted Tailscale Serve. On Vercel
  // this header is arbitrary caller input and must never grant owner access.
  if (!process.env.VERCEL && request.headers.get("tailscale-user-login")?.trim()) {
    return true;
  }
  return isOwnerSessionAuthorized(request, secret, now);
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
