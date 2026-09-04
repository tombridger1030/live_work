import { expect, test } from "bun:test";
import {
  createOwnerSessionToken,
  isOwnerMutationAuthorized,
  isOwnerSecret,
  isOwnerSessionAuthorized,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth";
import { checkOwnerSessionRateLimit } from "@/lib/rate-limit";
import { validateWeeklyGoal } from "@/lib/weekly-goal";

test("weekly-goal validation accepts Monday targets and rejects invalid values", () => {
  expect(validateWeeklyGoal("2026-06-22", 100, 40)).toEqual({ ok: true });
  expect(validateWeeklyGoal("2026-06-23", 100, 40).ok).toBe(false);
  expect(validateWeeklyGoal("2026-06-22", 0, 40).ok).toBe(false);
  expect(validateWeeklyGoal("2026-06-22", 100, 168.1).ok).toBe(false);
});

test("owner session token is signed, expires, and never contains the secret", () => {
  const secret = "owner-secret-for-test";
  const now = Date.UTC(2026, 6, 21, 12);
  const token = createOwnerSessionToken(secret, now);
  const request = new Request("http://localhost/api/ledger", { headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` } });
  expect(token).not.toContain(secret);
  expect(isOwnerSecret(secret, secret)).toBe(true);
  expect(isOwnerSecret("wrong", secret)).toBe(false);
  expect(isOwnerSessionAuthorized(request, secret, now + 1_000)).toBe(true);
  expect(isOwnerSessionAuthorized(request, "rotated-secret", now + 1_000)).toBe(false);
  expect(isOwnerSessionAuthorized(request, secret, now + (OWNER_SESSION_MAX_AGE_SECONDS + 1) * 1_000)).toBe(false);
});

test("owner session login throttles repeated attempts per client", async () => {
  const key = `weekly-goal-test-${Date.now()}`;
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(await checkOwnerSessionRateLimit(key, now)).toEqual({ allowed: true });
  }
  const blocked = await checkOwnerSessionRateLimit(key, now);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
});

test("same-origin Tailscale Serve identity authorizes owner mutations", () => {
  const authorized = new Request("https://tally.test/api/ledger", {
    method: "POST",
    headers: {
      origin: "https://tally.test",
      "tailscale-user-login": "owner@example.test",
    },
  });
  const crossOrigin = new Request("https://tally.test/api/ledger", {
    method: "POST",
    headers: {
      origin: "https://attacker.test",
      "tailscale-user-login": "owner@example.test",
    },
  });

  expect(isOwnerMutationAuthorized(authorized, null)).toBe(true);
  expect(isOwnerMutationAuthorized(crossOrigin, null)).toBe(false);
});

test("Tailscale proxy origin is reconstructed from trusted forwarded headers", () => {
  const request = new Request("http://tally.tailnet.test/api/ledger", {
    method: "POST",
    headers: {
      origin: "https://tally.tailnet.test",
      "tailscale-user-login": "owner@example.test",
      "x-forwarded-host": "tally.tailnet.test",
      "x-forwarded-proto": "https",
    },
  });

  expect(isOwnerMutationAuthorized(request, null)).toBe(true);
});
