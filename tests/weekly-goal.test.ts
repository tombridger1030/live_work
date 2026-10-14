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
import {
  channelWeeklyGoal,
  connectionRequestGoal,
  isStoredWeeklyGoal,
  outreachGoalOf,
  storedWeeklyGoal,
  validateWeeklyGoal,
} from "@/lib/weekly-goal";

// Amended 2026-10-13 by the owner: new goals are connection requests only;
// emails are bonus.
test("weekly-goal validation accepts Monday request goals and rejects invalid values", () => {
  expect(validateWeeklyGoal("2026-06-22", 250, 40)).toEqual({ ok: true });
  expect(validateWeeklyGoal("2026-06-23", 250, 40).ok).toBe(false); // not a Monday
  expect(validateWeeklyGoal("2026-06-22", 0, 40).ok).toBe(false); // nothing to send
  expect(validateWeeklyGoal("2026-06-22", 10.5, 40).ok).toBe(false);
  expect(validateWeeklyGoal("2026-06-22", -1, 40).ok).toBe(false);
  expect(validateWeeklyGoal("2026-06-22", 250, 168.1).ok).toBe(false);
});

test("a new goal is stored as a channel goal asking for 0 emails", () => {
  const goal = connectionRequestGoal("2026-10-12", 250, 55);
  expect(goal).toEqual({
    weekStart: "2026-10-12",
    reachouts: 250,
    hours: 55,
    emails: 0,
    connectionRequests: 250,
  });
  expect(isStoredWeeklyGoal(goal)).toBe(true);
  expect(outreachGoalOf(goal)).toEqual({
    kind: "channels",
    emails: 0,
    connectionRequests: 250,
  });
});

test("stored goals of either generation round-trip, and a channel goal's total must add up", () => {
  const channel = channelWeeklyGoal("2026-10-12", 100, 50, 55);
  expect(channel).toEqual({
    weekStart: "2026-10-12",
    reachouts: 150,
    hours: 55,
    emails: 100,
    connectionRequests: 50,
  });
  expect(outreachGoalOf(channel)).toEqual({
    kind: "channels",
    emails: 100,
    connectionRequests: 50,
  });
  expect(outreachGoalOf({ reachouts: 150 })).toEqual({
    kind: "touches",
    touches: 150,
  });
  expect(storedWeeklyGoal("2026-10-12", outreachGoalOf(channel), 55)).toEqual(
    channel,
  );

  expect(isStoredWeeklyGoal({ reachouts: 150, hours: 55 })).toBe(true);
  expect(isStoredWeeklyGoal({ reachouts: 1500, hours: 55 })).toBe(true); // above the daily-count cap, still a valid week
  expect(
    isStoredWeeklyGoal({
      reachouts: 150,
      hours: 55,
      emails: 100,
      connectionRequests: 50,
    }),
  ).toBe(true);
  expect(
    isStoredWeeklyGoal({
      reachouts: 140,
      hours: 55,
      emails: 100,
      connectionRequests: 50,
    }),
  ).toBe(false);
  expect(isStoredWeeklyGoal({ reachouts: 150, hours: 55, emails: 150 })).toBe(
    false,
  );
  expect(isStoredWeeklyGoal({ reachouts: 0, hours: 55 })).toBe(false);
});

test("owner session token is signed, expires, and never contains the secret", () => {
  const secret = "owner-secret-for-test";
  const now = Date.UTC(2026, 6, 21, 12);
  const token = createOwnerSessionToken(secret, now);
  const request = new Request("http://localhost/api/ledger", {
    headers: { cookie: `${OWNER_SESSION_COOKIE}=${token}` },
  });
  expect(token).not.toContain(secret);
  expect(isOwnerSecret(secret, secret)).toBe(true);
  expect(isOwnerSecret("wrong", secret)).toBe(false);
  expect(isOwnerSessionAuthorized(request, secret, now + 1_000)).toBe(true);
  expect(isOwnerSessionAuthorized(request, "rotated-secret", now + 1_000)).toBe(
    false,
  );
  expect(
    isOwnerSessionAuthorized(
      request,
      secret,
      now + (OWNER_SESSION_MAX_AGE_SECONDS + 1) * 1_000,
    ),
  ).toBe(false);
});

test("owner session login throttles repeated attempts per client", async () => {
  const key = `weekly-goal-test-${Date.now()}`;
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(await checkOwnerSessionRateLimit(key, now)).toEqual({
      allowed: true,
    });
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
