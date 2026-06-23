import { timingSafeEqual } from "node:crypto";

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

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
