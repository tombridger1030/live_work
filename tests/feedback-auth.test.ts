import { expect, test } from "bun:test";
import { createOwnerSessionToken, OWNER_SESSION_COOKIE } from "@/lib/auth";
import { POST as feedbackPost } from "@/app/api/feedback/route";

// Regression guard. /api/feedback was unauthenticated on the assumption that the
// dashboard was effectively private. Once the record is publicly reachable, an
// open write lets anyone scrape a snapshot id off the page and rewrite the public
// accountability record — and poison the `human_verified` rows that the
// corrections eval and the vision-model benchmark treat as ground truth.
const TEST_SECRET = "feedback-auth-test-secret";

// A syntactically valid id that will never exist, so the authorized case stops at
// the snapshot lookup and writes nothing.
function correctionRequest(cookie?: string): Request {
  return new Request("https://example.test/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({
      snapshotId: "00000000-0000-4000-8000-000000000000",
      field: "present",
      value: false
    })
  });
}

async function withOwnerSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OWNER_SECRET;
  process.env.OWNER_SECRET = TEST_SECRET;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OWNER_SECRET;
    else process.env.OWNER_SECRET = previous;
  }
}

test("feedback rejects a correction with no owner session", async () => {
  await withOwnerSecret(async () => {
    expect((await feedbackPost(correctionRequest())).status).toBe(401);
  });
});

test("feedback rejects a forged owner-session cookie", async () => {
  await withOwnerSecret(async () => {
    const forged = `${OWNER_SESSION_COOKIE}=${Math.floor(Date.now() / 1000)}.deadbeef`;
    expect((await feedbackPost(correctionRequest(forged))).status).toBe(401);
  });
});

test("feedback accepts a signed owner session and reaches the snapshot lookup", async () => {
  await withOwnerSecret(async () => {
    const token = createOwnerSessionToken(TEST_SECRET);
    const response = await feedbackPost(correctionRequest(`${OWNER_SESSION_COOKIE}=${token}`));
    // 404 = past the auth gate, stopped at the unknown snapshot (nothing written).
    expect(response.status).toBe(404);
  });
});
