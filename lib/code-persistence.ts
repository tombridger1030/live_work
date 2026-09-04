import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { z } from "zod";
import { codeSnapshotSchema, codeVelocity, type CodePulseData, type CodeSnapshot, type CodeWeekActivity } from "@/lib/code-velocity";
import { fetchCodeSnapshot, githubDayWindow } from "@/lib/github";
import { appTimeZone, isValidDayKey, localDayKey, weekStartForDay } from "@/lib/time";
import type { LedgerData } from "@/lib/ledger";

const dailySchema = z.object({ date: z.string().refine(isValidDayKey), commits: z.number().int().nonnegative(), merges: z.number().int().nonnegative(), lastCommitAt: z.string().datetime({ offset: true }).nullable() });
export type CodeDayActivity = z.infer<typeof dailySchema>;

const stateSchema = z.object({
  version: z.literal(1),
  snapshot: codeSnapshotSchema.nullable(),
  failed: z.boolean(),
  attemptedAt: z.number().finite(),
  lease: z.object({ id: z.string(), until: z.number().finite() }).nullable(),
  deliveries: z.array(z.string()).max(256),
  pending: z.boolean(),
  days: z.record(dailySchema).default({}),
});
type CodeState = z.infer<typeof stateSchema>;
type VersionedState = { state: CodeState; etag: string | null };

/** Atomic storage boundary: null ETag means create-only, otherwise compare-and-swap.
 * `write` returns false ONLY on a write conflict; all service/storage failures throw.
 * Readers must bypass caches. Implementations must never persist tokens or payloads.
 */
export type CodeStore = {
  read(): Promise<VersionedState>;
  write(state: CodeState, etag: string | null): Promise<boolean>;
};

/** Logs only allowlisted diagnostics. Never emits an upstream message, stack,
 * URL, response body, credential, or arbitrary error name.
 */
export function logCodeFailure(stage: "route" | "acquire" | "fetch" | "save" | "save-failure", error: unknown): void {
  const candidate = error instanceof Error ? error : null;
  const message = candidate?.message ?? "";
  const knownNames = new Set(["Error", "TypeError", "ZodError", "AbortError", "TimeoutError", "BlobError", "BlobPreconditionFailedError", "BlobAccessError", "BlobServiceNotAvailable", "BlobServiceRateLimited", "BlobStoreNotFoundError", "BlobStoreSuspendedError", "BlobUnknownError", "BlobRequestAbortedError"]);
  const statusMatch = message.match(/(?:request failed \(|status(?: code)?[ :=]+)([45]\d{2})/i);
  const reason = message === "Code storage is busy" ? "cas-conflicts-exhausted"
    : /not configured|GITHUB_REPO|GITHUB_AUTHOR|GITHUB_TOKEN/.test(message) ? "configuration"
    : /window limit/.test(message) ? "pagination-limit"
    : /weak ETag/.test(message) ? "weak-etag"
    : "operation-failed";
  console.error(JSON.stringify({ component: "code-pulse", stage, name: candidate && knownNames.has(candidate.name) ? candidate.name : "UnknownError", reason, ...(statusMatch ? { status: Number(statusMatch[1]) } : {}) }));
}

function emptyState(): CodeState {
  return { version: 1, snapshot: null, failed: false, attemptedAt: 0, lease: null, deliveries: [], pending: false, days: {} };
}

/** Isolates data by configured repository/author and from every Mac-published path.
 * Requires the existing private Blob token; missing storage is an error, not zero.
 */
export function codeBlobStore(): CodeStore {
  const repo = process.env.GITHUB_REPO?.trim();
  const author = process.env.GITHUB_AUTHOR?.trim();
  if (!repo || !author || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Code Pulse is not configured");
  const scope = createHash("sha256").update(`${repo.toLowerCase()}:${author.toLowerCase()}:${appTimeZone()}`).digest("hex");
  const pathname = `code-pulse/v1/${scope}.json`;
  return {
    async read() {
      // Compression weakens the response ETag, which Blob cannot use for CAS.
      // Identity keeps the state and its strong write token in the SAME read.
      const result = await get(pathname, { access: "private", useCache: false, headers: { "accept-encoding": "identity" } });
      if (!result) return { state: emptyState(), etag: null };
      if (result.statusCode !== 200) throw new Error("Code storage read failed");
      if (!result.blob.etag || result.blob.etag.startsWith("W/")) throw new Error("Code storage returned a weak ETag");
      return { state: stateSchema.parse(await new Response(result.stream).json()), etag: result.blob.etag };
    },
    async write(state, etag) {
      try {
        await put(pathname, JSON.stringify(stateSchema.parse(state)), {
          access: "private", addRandomSuffix: false, allowOverwrite: etag !== null,
          ...(etag === null ? {} : { ifMatch: etag }), contentType: "application/json",
          cacheControlMaxAge: 60,
        });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false;
        // A racing create-only write is a conflict. Other write failures throw.
        if (etag === null && error instanceof Error && /already exists/i.test(error.message)) return false;
        throw error;
      }
    },
  };
}

async function change(store: CodeStore, update: (state: CodeState) => CodeState | null): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state, etag } = await store.read();
    const next = update(state);
    if (!next) return false;
    if (await store.write(next, etag)) return true;
  }
  throw new Error("Code storage is busy");
}

/** Public aggregate only. Never leaks repository identity, credentials, or raw SHAs.
 * Storage failures throw so the HTTP/client boundary can retain its saved display.
 */
export async function readCodePulse(store = codeBlobStore(), now = Date.now(), selectedDay = localDayKey(new Date(now))): Promise<CodePulseData> {
  const { state } = await store.read();
  const result = codeVelocity(state.snapshot, now, state.failed);
  if (!isValidDayKey(selectedDay)) throw new Error("Invalid code day");
  const days = archiveDays(state.days, state.snapshot);
  return { ...result, day: days[selectedDay] ?? null, week: codeWeekActivity(days, selectedDay) };
}

function shiftDay(day: string, amount: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + amount);
  return at.toISOString().slice(0, 10);
}

/** Returns a complete week-to-date comparison. Both periods must have an
 * observed record for every elapsed local day, so missing history never reads
 * as a zero or a made-up improvement.
 */
export function codeWeekActivity(days: Record<string, CodeDayActivity>, through: string): CodeWeekActivity | null {
  if (!isValidDayKey(through)) throw new Error("Invalid code day");
  const weekStart = weekStartForDay(through);
  const span = Array.from({ length: Math.floor((Date.parse(`${through}T12:00:00Z`) - Date.parse(`${weekStart}T12:00:00Z`)) / 86_400_000) + 1 }, (_, index) => shiftDay(weekStart, index));
  const current = span.map((day) => days[day]);
  if (current.some((day) => !day)) return null;
  const prior = span.map((day) => days[shiftDay(day, -7)]);
  const sum = (items: CodeDayActivity[]) => ({ commits: items.reduce((total, day) => total + day.commits, 0), merges: items.reduce((total, day) => total + day.merges, 0) });
  const total = sum(current as CodeDayActivity[]);
  return { weekStart, through, ...total, comparison: prior.some((day) => !day) ? null : sum(prior as CodeDayActivity[]) };
}

/** One Blob read for Ledger's date range. Returned days REPLACE saved coding
 * fields, never add to them. Missing keys are unverified, not zero. Keeps 120
 * observed local dates across rolling backfills; cold start covers only 35 days.
 */
export async function readCodeDays(from: string, to: string, store = codeBlobStore()): Promise<Record<string, CodeDayActivity>> {
  if (!isValidDayKey(from) || !isValidDayKey(to) || from > to) throw new Error("Invalid code day range");
  const { state } = await store.read();
  return Object.fromEntries(Object.entries(archiveDays(state.days, state.snapshot)).filter(([day]) => day >= from && day <= to));
}

/** Overlays verified daily counts and recalculates week coding totals with one
 * Blob read, never GitHub requests. Replaces, never adds; missing dates and store
 * failures preserve the published values. Input objects, business activity
 * scores, manual fields, charts and targets remain unchanged.
 */
export async function applyCodeDaysToLedger(
  data: LedgerData,
  loadDays: (from: string, to: string) => Promise<Record<string, CodeDayActivity>> = readCodeDays,
): Promise<LedgerData> {
  try {
    const codes = await loadDays(data.startDay, data.endDay);
    const overlay = (day: LedgerData["days"][number]) => codes[day.day] ? {
      ...day, commits: codes[day.day].commits, merges: codes[day.day].merges,
    } : day;
    return {
      ...data, days: data.days.map(overlay),
      weeks: data.weeks.map((week) => {
        const days = week.days.map(overlay);
        return { ...week, days, commits: days.reduce((sum, day) => sum + day.commits, 0), merges: days.reduce((sum, day) => sum + day.merges, 0) };
      }),
    };
  } catch {
    return data;
  }
}

function snapshotDay(snapshot: CodeSnapshot, selectedDay: string): CodeDayActivity | null {
  const { start, end } = githubDayWindow(selectedDay);
  if (Date.parse(snapshot.from) > start.getTime() || Date.parse(snapshot.through) <= start.getTime()) return null;
  const inDay = (events: CodeSnapshot["commits"]) => [...new Map(events.filter((event) => Date.parse(event.at) >= start.getTime() && Date.parse(event.at) < end.getTime()).map((event) => [event.id, event])).values()];
  const commits = inDay(snapshot.commits);
  return {
    date: selectedDay, commits: commits.length, merges: inDay(snapshot.merges).length,
    lastCommitAt: commits.map((commit) => commit.at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
  };
}

function archiveDays(previous: Record<string, CodeDayActivity>, snapshot: CodeSnapshot | null): Record<string, CodeDayActivity> {
  if (!snapshot) return previous;
  const days = { ...previous };
  const last = localDayKey(new Date(snapshot.through));
  let day = localDayKey(new Date(snapshot.from));
  while (day <= last) {
    const activity = snapshotDay(snapshot, day);
    if (activity) days[day] = activity;
    const next = new Date(`${day}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
  }
  return Object.fromEntries(Object.entries(days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 120));
}

/** Durable event receipt, deduplicated by signed body digest (delivery headers are
 * not signed). Retains the latest 256 receipts; older replays remain idempotent
 * because reconciliation replaces canonical totals, never increments them.
 */
export async function queueCodeDelivery(digest: string, store = codeBlobStore()): Promise<boolean> {
  return change(store, (state) => state.deliveries.includes(digest) ? null : {
    ...state, pending: true, deliveries: [...state.deliveries, digest].slice(-256),
  });
}

/** Reconciles without browser traffic or a Mac. A five-minute durable lease
 * bounds concurrent GitHub work; attempts cool down for one minute. Expired
 * workers cannot overwrite newer workers. Success replaces all canonical data;
 * failure marks the saved snapshot stale without destroying it. Pending events
 * remain durable if a worker is interrupted and the next scheduled call repairs it.
 */
export async function reconcileCodePulse(
  store = codeBlobStore(),
  fetchSnapshot: (now: number) => Promise<CodeSnapshot> = fetchCodeSnapshot,
  now = Date.now(),
): Promise<"updated" | "busy"> {
  const id = randomUUID();
  let acquired: boolean;
  try {
    acquired = await change(store, (state) => {
      if ((state.lease && state.lease.until > now) || now - state.attemptedAt < 60_000) return null;
      return { ...state, attemptedAt: now, lease: { id, until: now + 300_000 }, pending: false };
    });
  } catch (error) {
    logCodeFailure("acquire", error);
    throw error;
  }
  if (!acquired) return "busy";
  let stage: "fetch" | "save" = "fetch";
  try {
    const snapshot = codeSnapshotSchema.parse(await fetchSnapshot(now));
    if (Date.parse(snapshot.through) !== now) throw new Error("Unexpected reconciliation window");
    stage = "save";
    const saved = await change(store, (state) => state.lease?.id !== id ? null : {
      ...state, snapshot, days: archiveDays(state.days, snapshot), failed: false, lease: null,
    });
    return saved ? "updated" : "busy";
  } catch (error) {
    logCodeFailure(stage, error);
    try {
      await change(store, (state) => state.lease?.id !== id ? null : {
        ...state, failed: true, lease: null, pending: true,
      });
    } catch (saveError) {
      logCodeFailure("save-failure", saveError);
    }
    throw new Error("Code Pulse refresh failed; saved activity preserved");
  }
}

/** Validates raw bytes with HMAC-SHA256 before parsing. Secret must be server-only.
 * Missing/malformed signatures fail closed; comparison is constant-time.
 */
export function validCodeSignature(body: Uint8Array, signature: string | null, secret: string | undefined): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

/** Accepts only bounded, signed events for the server-selected repository.
 * Persists the receipt before scheduling work. `schedule` must keep the worker
 * alive after responding (Next after), and scheduled reconciliation is the retry
 * mechanism. Response errors deliberately contain no upstream or secret details.
 */
export async function receiveCodeWebhook(
  request: Request,
  schedule: (work: () => Promise<void>) => void,
  storeFactory: () => CodeStore = codeBlobStore,
): Promise<Response> {
  if (!process.env.GITHUB_WEBHOOK_SECRET) return Response.json({ error: "Webhook not configured" }, { status: 503 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Missing payload" }, { status: 400 });
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_048_576) {
      await reader.cancel();
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks);
  if (!validCodeSignature(body, request.headers.get("x-hub-signature-256"), process.env.GITHUB_WEBHOOK_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let payload: { repository: { full_name: string }; action?: string; pull_request?: { merged: boolean } };
  try {
    payload = z.object({ repository: z.object({ full_name: z.string() }), action: z.string().optional(), pull_request: z.object({ merged: z.boolean() }).optional() }).parse(JSON.parse(body.toString("utf8")));
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  if (payload.repository.full_name.toLowerCase() !== process.env.GITHUB_REPO?.trim().toLowerCase()) return Response.json({ error: "Repository not allowed" }, { status: 403 });
  const event = request.headers.get("x-github-event");
  if (event !== "push" && !(event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged)) return Response.json({ status: "ignored" });
  try {
    const store = storeFactory();
    const accepted = await queueCodeDelivery(createHash("sha256").update(body).digest("hex"), store);
    schedule(async () => {
      try { await reconcileCodePulse(store); } catch { console.warn("[code-pulse] Refresh failed; scheduled reconciliation will retry"); }
    });
    return Response.json({ status: accepted ? "queued" : "duplicate" }, { status: 202 });
  } catch {
    return Response.json({ error: "Code storage unavailable" }, { status: 503 });
  }
}
