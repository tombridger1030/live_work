// TEMPORARY: restores tally's history out of the (Neon) Postgres database into
// the self-hosted local JSON store. Delete once the migration is done.
//
// Reads with `pg` directly rather than lib/store so that POSTGRES_URL is never
// set in this process — if it were, every store WRITE below would go back to
// Postgres instead of the local JSON store we are restoring into.
//
// Original snapshot ids are preserved (not re-created via saveSnapshot) so that
// thumbnail URLs and feedback rows keep pointing at the same records.
//
// Usage:
//   NEON_RESTORE_URL="postgres://..." bun scripts/_neon-restore.ts            # dry run
//   NEON_RESTORE_URL="postgres://..." bun scripts/_neon-restore.ts --apply    # write
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import type { FeedbackEntry, HourlyCheckin, LedgerEntry, NudgeMessage, SnapshotRow, WeeklyGoal } from "@/lib/types";

const url = process.env.NEON_RESTORE_URL;
if (!url) {
  throw new Error("NEON_RESTORE_URL not set");
}
const apply = Bun.argv.includes("--apply");
const dataDir = process.env.WORK_LIVE_DATA_DIR || path.join(process.cwd(), ".work-live");
const storeFile = path.join(dataDir, "store.json");
const thumbDir = path.join(dataDir, "thumbs");

const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

// --- read everything out of Postgres -----------------------------------------
const snapshotRows = rowsOf<Record<string, unknown>>(
  await pool.query(`SELECT * FROM snapshots ORDER BY captured_at DESC`)
);
const checkinRows = rowsOf<Record<string, unknown>>(
  await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, hour, avg_score, present_pct, headphones_pct, verdict, critical FROM hourly_checkins`)
);
const ledgerRows = rowsOf<Record<string, unknown>>(
  await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, reachouts, feature_done, replies, meetings, commits, merges FROM scoreboard_entries`)
);
const goalRows = rowsOf<Record<string, unknown>>(
  await pool.query(`SELECT to_char(week_start,'YYYY-MM-DD') AS week_start, reachouts, hours FROM weekly_goals`)
);
const nudgeRows = rowsOf<Record<string, unknown>>(
  await pool.query(`SELECT id, created_at, direction, kind, text FROM nudge_messages ORDER BY created_at DESC`)
);
const feedbackRows = rowsOf<Record<string, unknown>>(
  await pool.query(`SELECT id, snapshot_id, field, old_value, new_value, created_at FROM feedback`)
);

console.log("read from Postgres:", {
  snapshots: snapshotRows.length,
  hourlyCheckins: checkinRows.length,
  ledgerEntries: ledgerRows.length,
  weeklyGoals: goalRows.length,
  nudgeMessages: nudgeRows.length,
  feedback: feedbackRows.length
});

const humanVerified = snapshotRows.filter((row) => row.human_verified === true).length;
const headphonesGold = new Set(
  feedbackRows.filter((row) => row.field === "headphones").map((row) => String(row.snapshot_id))
);
console.log("gold potential:", { humanVerified, headphonesCorrections: headphonesGold.size });

if (!apply) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to restore.");
  await pool.end();
  process.exit(0);
}

// --- thumbnails: data URI or Blob URL -> local files --------------------------
await mkdir(thumbDir, { recursive: true });
let thumbsWritten = 0;
let thumbsMissing = 0;
for (const row of snapshotRows) {
  const id = String(row.id);
  const stored = row.thumb_url ? String(row.thumb_url) : "";
  const target = path.join(thumbDir, `${id}.jpg`);
  if (existsSync(target)) continue;

  if (stored.startsWith("data:")) {
    await writeFile(target, Buffer.from(stored.slice(stored.indexOf(",") + 1), "base64"));
    thumbsWritten += 1;
  } else if (stored.startsWith("https://")) {
    const response = await fetch(stored);
    if (response.ok) {
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
      thumbsWritten += 1;
    } else {
      thumbsMissing += 1;
    }
  } else {
    thumbsMissing += 1;
  }
}
console.log("thumbnails:", { written: thumbsWritten, missing: thumbsMissing });

// --- merge into the local store, preserving anything captured since cutover ---
const existing = existsSync(storeFile)
  ? JSON.parse(await readFile(storeFile, "utf8"))
  : { snapshots: [], hourlyCheckins: [], scoreboardEntries: [], weeklyGoals: [], nudgeMessages: [], feedback: [], settings: {} };

const restoredSnapshots: SnapshotRow[] = snapshotRows.map((row) => ({
  id: String(row.id),
  capturedAt: new Date(row.captured_at as string | Date).toISOString(),
  present: Boolean(row.present),
  headphones: Boolean(row.headphones),
  eyesOnScreen: Boolean(row.eyes_on_screen),
  posture: row.posture as SnapshotRow["posture"],
  score: Number(row.score),
  status: row.status as SnapshotRow["status"],
  note: String(row.note ?? ""),
  thumbUrl: `/api/thumb/${String(row.id)}`,
  frameHash: row.frame_hash ? String(row.frame_hash) : null,
  captureSource: row.capture_source ? (String(row.capture_source) as SnapshotRow["captureSource"]) : null,
  frameSignature: row.frame_signature ? String(row.frame_signature) : null,
  proofSignature: row.proof_signature ? String(row.proof_signature) : null,
  livenessStatus: row.liveness_status ? (String(row.liveness_status) as SnapshotRow["livenessStatus"]) : null,
  livenessScore: row.liveness_score == null ? null : Number(row.liveness_score),
  humanVerified: row.human_verified === true
}));

const byId = new Map<string, SnapshotRow>();
for (const snapshot of [...restoredSnapshots, ...(existing.snapshots as SnapshotRow[])]) {
  byId.set(snapshot.id, snapshot); // local (post-cutover) rows win on conflict
}

const checkinKey = (entry: HourlyCheckin) => `${entry.day}:${entry.hour}`;
const checkins = new Map<string, HourlyCheckin>();
for (const row of checkinRows) {
  const entry: HourlyCheckin = {
    day: String(row.day),
    hour: Number(row.hour),
    avgScore: Number(row.avg_score),
    presentPct: Number(row.present_pct),
    headphonesPct: Number(row.headphones_pct),
        unknownFrames: 0,
    verdict: String(row.verdict),
    critical: Boolean(row.critical)
  };
  checkins.set(checkinKey(entry), entry);
}
for (const entry of existing.hourlyCheckins as HourlyCheckin[]) {
  checkins.set(checkinKey(entry), entry);
}

const ledger = new Map<string, LedgerEntry>();
for (const row of ledgerRows) {
  ledger.set(String(row.day), {
    day: String(row.day),
    reachouts: Number(row.reachouts),
    featureDone: Boolean(row.feature_done),
    replies: Number(row.replies),
    meetings: Number(row.meetings),
    commits: Number(row.commits),
    merges: Number(row.merges)
  });
}
for (const entry of (existing.scoreboardEntries ?? []) as LedgerEntry[]) {
  ledger.set(entry.day, entry);
}

const goals = new Map<string, WeeklyGoal>();
for (const row of goalRows) {
  goals.set(String(row.week_start), { weekStart: String(row.week_start), reachouts: Number(row.reachouts), hours: Number(row.hours) });
}
for (const goal of (existing.weeklyGoals ?? []) as WeeklyGoal[]) {
  goals.set(goal.weekStart, goal);
}

const nudges = new Map<string, NudgeMessage>();
for (const row of nudgeRows) {
  nudges.set(String(row.id), {
    id: String(row.id),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    direction: row.direction as NudgeMessage["direction"],
    kind: String(row.kind),
    text: String(row.text)
  });
}
for (const message of (existing.nudgeMessages ?? []) as NudgeMessage[]) {
  nudges.set(message.id, message);
}

const feedback = new Map<string, FeedbackEntry>();
for (const row of feedbackRows) {
  feedback.set(String(row.id), {
    id: String(row.id),
    snapshotId: String(row.snapshot_id),
    field: String(row.field),
    oldValue: String(row.old_value),
    newValue: String(row.new_value),
    createdAt: new Date(row.created_at as string | Date).toISOString()
  });
}
for (const entry of (existing.feedback ?? []) as FeedbackEntry[]) {
  feedback.set(entry.id, entry);
}

// Settings are intentionally NOT restored: the local paused/blur state is the
// live one, and clobbering it could silently pause capture.
const merged = {
  ...existing,
  snapshots: Array.from(byId.values()).sort(
    (left, right) => new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime()
  ),
  hourlyCheckins: Array.from(checkins.values()),
  scoreboardEntries: Array.from(ledger.values()).sort((left, right) => left.day.localeCompare(right.day)),
  weeklyGoals: Array.from(goals.values()).sort((left, right) => left.weekStart.localeCompare(right.weekStart)),
  nudgeMessages: Array.from(nudges.values()),
  feedback: Array.from(feedback.values())
};

await mkdir(dataDir, { recursive: true });
const temp = `${storeFile}.restore.tmp`;
await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`);
await rename(temp, storeFile);

console.log("restored into", storeFile, {
  snapshots: merged.snapshots.length,
  hourlyCheckins: merged.hourlyCheckins.length,
  ledgerEntries: merged.scoreboardEntries.length,
  weeklyGoals: merged.weeklyGoals.length,
  nudgeMessages: merged.nudgeMessages.length,
  feedback: merged.feedback.length
});

await pool.end();
process.exit(0);
