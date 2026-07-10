import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DayHistory, HourlyCheckin, LedgerEntry, NudgeMessage, NudgeState, ScoreResult, Settings, Signals, SnapshotRow } from "@/lib/types";
import { appTimeZone, isQuietHour, isScoringHour, localDayKey, localHour, quietHourEnd, quietHourStart, scoringEndHour, scoringStartHour } from "@/lib/time";
import { RUBRIC_VERSION } from "@/lib/score";
import { correctableFields, type CorrectableField } from "@/lib/feedback";

type SaveSnapshotInput = {
  capturedAt?: Date;
  signals: Signals;
  score: ScoreResult;
  thumbnail: Uint8Array;
} & SnapshotCaptureMetadata;
type SnapshotCaptureMetadata = {
  frameHash?: string | null;
  captureSource?: SnapshotRow["captureSource"];
  frameSignature?: string | null;
  proofSignature?: string | null;
  livenessStatus?: SnapshotRow["livenessStatus"];
  livenessScore?: number | null;
};


type LocalState = {
  snapshots: SnapshotRow[];
  hourlyCheckins: HourlyCheckin[];
  scoreboardEntries: LedgerEntry[];
  nudgeMessages: NudgeMessage[];
  settings: Settings;
};

const localRoot = path.join(process.cwd(), ".work-live");
const localStoreFile = path.join(localRoot, "store.json");
const localThumbRoot = path.join(localRoot, "thumbs");

let postgresSchemaReady = false;

function hasPostgresConfig(): boolean {
  return Boolean(
    process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.POSTGRES_HOST
  );
}

function defaultState(): LocalState {
  return {
    snapshots: [],
    hourlyCheckins: [],
    scoreboardEntries: [],
    nudgeMessages: [],
    settings: {
      paused: false,
      blur: false,
      updatedAt: new Date(0).toISOString(),
      snoozeUntil: null,
      nudgeState: null
    }
  };
}

function normalizeCheckin(checkin: HourlyCheckin): HourlyCheckin {
  return { ...checkin, critical: Boolean(checkin.critical) };
}

async function readLocalState(): Promise<LocalState> {
  if (!existsSync(localStoreFile)) {
    return defaultState();
  }

  const state = JSON.parse(await readFile(localStoreFile, "utf8")) as LocalState;
  return {
    ...state,
    hourlyCheckins: state.hourlyCheckins.map(normalizeCheckin),
    scoreboardEntries: state.scoreboardEntries ?? [],
    nudgeMessages: state.nudgeMessages ?? []
  };
}

async function writeLocalState(state: LocalState): Promise<void> {
  await mkdir(localRoot, { recursive: true });
  // Atomic write: a unique temp file + rename so concurrent writers never leave
  // the store half-written (which would crash every reader on JSON.parse).
  const tempFile = `${localStoreFile}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tempFile, localStoreFile);
}

// Serializes a read-modify-write of the local JSON store so concurrent writers
// (e.g. a debounced reachouts flush racing a feature toggle) can't lose updates
// or interleave. Postgres paths don't use this — the database upserts atomically.
let localStateChain: Promise<unknown> = Promise.resolve();
async function withLocalState<T>(mutator: (state: LocalState) => T | Promise<T>): Promise<T> {
  const run = localStateChain.then(async () => {
    const state = await readLocalState();
    const result = await mutator(state);
    await writeLocalState(state);
    return result;
  });
  localStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function persistThumbnail(id: string, thumbnail: Uint8Array): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = await import("@vercel/blob");
    const result = await put(`work-live/thumbs/${id}.jpg`, Buffer.from(thumbnail), {
      access: "public",
      addRandomSuffix: false,
      contentType: "image/jpeg"
    });
    return result.url;
  }

  if (hasPostgresConfig()) {
    // No Blob store provisioned: inline the thumbnail as a data URI persisted in
    // the snapshot row. Thumbnails stay modest (<=768px, q72), so this keeps the
    // deployed tracer bullet on a single service (Postgres) with no object store.
    return `data:image/jpeg;base64,${Buffer.from(thumbnail).toString("base64")}`;
  }

  await mkdir(localThumbRoot, { recursive: true });
  await writeFile(path.join(localThumbRoot, `${id}.jpg`), Buffer.from(thumbnail));
  return `/api/thumb/${id}`;
}

async function sqlClient() {
  const { sql } = await import("@vercel/postgres");
  if (!postgresSchemaReady) {
    await sql`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        captured_at TIMESTAMPTZ NOT NULL,
        present BOOLEAN NOT NULL,
        headphones BOOLEAN NOT NULL,
        eyes_on_screen BOOLEAN NOT NULL,
        posture TEXT NOT NULL CHECK (posture IN ('upright', 'slouched', 'unknown')),
        score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
        status TEXT NOT NULL CHECK (status IN ('locked_in', 'present', 'away')),
        note TEXT NOT NULL,
        thumb_url TEXT NOT NULL
      )
    `;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS frame_hash TEXT`;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS capture_source TEXT`;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS frame_signature TEXT`;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS proof_signature TEXT`;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS liveness_status TEXT`;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS liveness_score DOUBLE PRECISION`;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS rubric_version INTEGER`;
    await sql`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS human_verified BOOLEAN`;
    await sql`CREATE INDEX IF NOT EXISTS snapshots_captured_at_idx ON snapshots (captured_at DESC)`;
    await sql`
      CREATE TABLE IF NOT EXISTS hourly_checkins (
        day DATE NOT NULL,
        hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
        avg_score INTEGER NOT NULL CHECK (avg_score >= 0 AND avg_score <= 100),
        present_pct INTEGER NOT NULL CHECK (present_pct >= 0 AND present_pct <= 100),
        headphones_pct INTEGER NOT NULL CHECK (headphones_pct >= 0 AND headphones_pct <= 100),
        verdict TEXT NOT NULL,
        PRIMARY KEY (day, hour)
      )
    `;
    await sql`ALTER TABLE hourly_checkins ADD COLUMN IF NOT EXISTS critical BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        paused BOOLEAN NOT NULL DEFAULT FALSE,
        blur BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (id = 1)
      )
    `;
    await sql`
      INSERT INTO settings (id, paused, blur)
      VALUES (1, FALSE, FALSE)
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ`;
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS nudge_state JSONB`;
    await sql`
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS scoreboard_entries (
        day DATE PRIMARY KEY,
        reachouts INTEGER NOT NULL DEFAULT 0 CHECK (reachouts >= 0),
        feature_done BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`ALTER TABLE scoreboard_entries ADD COLUMN IF NOT EXISTS replies INTEGER NOT NULL DEFAULT 0 CHECK (replies >= 0)`;
    await sql`ALTER TABLE scoreboard_entries ADD COLUMN IF NOT EXISTS meetings INTEGER NOT NULL DEFAULT 0 CHECK (meetings >= 0)`;
    await sql`ALTER TABLE scoreboard_entries ADD COLUMN IF NOT EXISTS commits INTEGER NOT NULL DEFAULT 0 CHECK (commits >= 0)`;
    await sql`ALTER TABLE scoreboard_entries ADD COLUMN IF NOT EXISTS merges INTEGER NOT NULL DEFAULT 0 CHECK (merges >= 0)`;
    await sql`
      CREATE TABLE IF NOT EXISTS nudge_messages (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        direction TEXT NOT NULL CHECK (direction IN ('out','in')),
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS nudge_messages_created_at_idx ON nudge_messages (created_at DESC)`;
    postgresSchemaReady = true;
  }
  return sql;
}

function mapSnapshot(row: Record<string, unknown>): SnapshotRow {
  const id = String(row.id);
  return {
    id,
    capturedAt: new Date(row.captured_at as string | Date).toISOString(),
    present: Boolean(row.present),
    headphones: Boolean(row.headphones),
    eyesOnScreen: Boolean(row.eyes_on_screen),
    posture: row.posture as SnapshotRow["posture"],
    score: Number(row.score),
    status: row.status as SnapshotRow["status"],
    note: String(row.note),
    // Cacheable route URL; the bytes are served by /api/thumb from the column.
    thumbUrl: `/api/thumb/${id}`,
    frameHash: row.frame_hash ? String(row.frame_hash) : null,
    captureSource: row.capture_source ? (String(row.capture_source) as SnapshotRow["captureSource"]) : null,
    frameSignature: row.frame_signature ? String(row.frame_signature) : null,
    proofSignature: row.proof_signature ? String(row.proof_signature) : null,
    livenessStatus: row.liveness_status ? (String(row.liveness_status) as SnapshotRow["livenessStatus"]) : null,
    livenessScore: row.liveness_score == null ? null : Number(row.liveness_score)
  };
}

function mapCheckin(row: Record<string, unknown>): HourlyCheckin {
  return {
    day: String(row.day).slice(0, 10),
    hour: Number(row.hour),
    avgScore: Number(row.avg_score),
    presentPct: Number(row.present_pct),
    headphonesPct: Number(row.headphones_pct),
    verdict: String(row.verdict),
    critical: Boolean(row.critical)
  };
}

function mapLedgerEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    day: String(row.day),
    reachouts: Number(row.reachouts),
    featureDone: Boolean(row.feature_done),
    replies: Number(row.replies),
    meetings: Number(row.meetings),
    commits: Number(row.commits),
    merges: Number(row.merges)
  };
}

function mapNudgeMessage(row: Record<string, unknown>): NudgeMessage {
  return {
    id: String(row.id),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    direction: row.direction as NudgeMessage["direction"],
    kind: String(row.kind),
    text: String(row.text)
  };
}

/**
 * Persists one analyzed snapshot and its derived thumbnail.
 *
 * Preconditions: analysis and scoring already succeeded; `thumbnail` is the
 * reduced public artifact, not the raw frame. Postconditions: exactly one
 * snapshot row exists for the returned id and no raw image bytes are stored.
 */
export async function saveSnapshot(input: SaveSnapshotInput): Promise<SnapshotRow> {
  const id = randomUUID();
  const capturedAt = input.capturedAt ?? new Date();
  const stored = await persistThumbnail(id, input.thumbnail);
  const row: SnapshotRow = {
    id,
    capturedAt: capturedAt.toISOString(),
    ...input.signals,
    ...input.score,
    // Expose a cacheable route URL, not the raw bytes; the thumbnail itself lives
    // in the `thumb_url` column (data URI) or local file and is served by the route.
    thumbUrl: `/api/thumb/${id}`,
    frameHash: input.frameHash ?? null,
    captureSource: input.captureSource ?? null,
    frameSignature: input.frameSignature ?? null,
    proofSignature: input.proofSignature ?? null,
    livenessStatus: input.livenessStatus ?? null,
    livenessScore: input.livenessScore ?? null
  };

  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    await sql`
      INSERT INTO snapshots (
        id, captured_at, present, headphones, eyes_on_screen, posture, score, status, note, thumb_url,
        frame_hash, rubric_version, capture_source, frame_signature, proof_signature, liveness_status, liveness_score
      )
      VALUES (
        ${row.id}, ${row.capturedAt}, ${row.present}, ${row.headphones}, ${row.eyesOnScreen},
        ${row.posture}, ${row.score}, ${row.status}, ${row.note}, ${stored},
        ${row.frameHash}, ${RUBRIC_VERSION}, ${row.captureSource}, ${row.frameSignature},
        ${row.proofSignature}, ${row.livenessStatus}, ${row.livenessScore}
      )
    `;
    return row;
  }

  const state = await readLocalState();
  state.snapshots = [row, ...state.snapshots]
    .sort((left, right) => new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime())
    .slice(0, 2000);
  await writeLocalState(state);
  return row;
}

export async function latestSnapshot(): Promise<SnapshotRow | null> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT id, captured_at, present, headphones, eyes_on_screen, posture, score, status, note, frame_hash, capture_source, frame_signature, proof_signature, liveness_status, liveness_score
      FROM snapshots ORDER BY captured_at DESC LIMIT 1
    `;
    return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
  }

  const state = await readLocalState();
  return state.snapshots[0] ?? null;
}

export async function snapshotsSince(since: Date): Promise<SnapshotRow[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT id, captured_at, present, headphones, eyes_on_screen, posture, score, status, note, frame_hash, capture_source, frame_signature, proof_signature, liveness_status, liveness_score
      FROM snapshots WHERE captured_at >= ${since.toISOString()} ORDER BY captured_at ASC
    `;
    return result.rows.map(mapSnapshot);
  }

  const state = await readLocalState();
  return state.snapshots
    .filter((snapshot) => new Date(snapshot.capturedAt).getTime() >= since.getTime())
    .sort((left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime());
}

/**
 * Deletes stored snapshots by id for owner-authenticated maintenance flows.
 * Preconditions: `ids` come from already-stored snapshot rows. Postconditions:
 * no matching snapshot rows remain; hourly rollups are intentionally untouched
 * so the caller can rebuild only the affected hours.
 */
export async function deleteSnapshotsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql.query("DELETE FROM snapshots WHERE id = ANY($1::text[])", [ids]);
    return result.rowCount ?? 0;
  }

  const toDelete = new Set(ids);
  const state = await readLocalState();
  const before = state.snapshots.length;
  state.snapshots = state.snapshots.filter((snapshot) => !toDelete.has(snapshot.id));
  await writeLocalState(state);
  return before - state.snapshots.length;
}

/**
 * Returns every snapshot whose local day equals `day` (YYYY-MM-DD), ascending.
 *
 * Queries a UTC window one day either side of `day` then filters by local day,
 * so timezone offset never drops or leaks a boundary snapshot.
 */
export async function snapshotsForDay(day: string): Promise<SnapshotRow[]> {
  const from = new Date(`${day}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${day}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 2);

  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT id, captured_at, present, headphones, eyes_on_screen, posture, score, status, note, frame_hash, capture_source, frame_signature, proof_signature, liveness_status, liveness_score
      FROM snapshots
      WHERE captured_at >= ${from.toISOString()} AND captured_at < ${to.toISOString()}
      ORDER BY captured_at ASC
    `;
    return result.rows.map(mapSnapshot).filter((snapshot) => localDayKey(new Date(snapshot.capturedAt)) === day);
  }

  const state = await readLocalState();
  return state.snapshots
    .filter((snapshot) => localDayKey(new Date(snapshot.capturedAt)) === day)
    .sort((left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime());
}

/**
 * Raw stored thumbnail reference for one snapshot id: a `data:` URI (Postgres,
 * no object store) or an https Blob URL. The /api/thumb route uses this to serve
 * the bytes, so bulk reads never carry thumbnails and the page ships only the
 * cacheable route URL. Returns null for unknown ids.
 */
export async function snapshotThumbnail(id: string): Promise<string | null> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`SELECT thumb_url FROM snapshots WHERE id = ${id} LIMIT 1`;
    return result.rows[0] ? String(result.rows[0].thumb_url) : null;
  }

  const state = await readLocalState();
  return state.snapshots.find((snapshot) => snapshot.id === id)?.thumbUrl ?? null;
}

/**
 * Raw thumbnail bytes for one snapshot id — decoded from the stored data URI,
 * fetched from the Blob URL, or read from the local file. The rubric backfill
 * re-runs the vision model on these. Null when the id or bytes are unavailable.
 */
export async function snapshotThumbnailBytes(id: string): Promise<Uint8Array | null> {
  if (hasPostgresConfig()) {
    const stored = await snapshotThumbnail(id);
    if (!stored) {
      return null;
    }
    if (stored.startsWith("data:")) {
      return new Uint8Array(Buffer.from(stored.slice(stored.indexOf(",") + 1), "base64"));
    }
    const response = await fetch(stored);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }

  const filePath = path.join(localThumbRoot, `${id}.jpg`);
  return existsSync(filePath) ? new Uint8Array(await readFile(filePath)) : null;
}

/**
 * Snapshots whose stored analysis predates `version` (older value or NULL),
 * oldest first, capped at `limit` — the queue the backfill re-analyzes against
 * the current rubric. Postgres-only; local dev (fixtures) has nothing to backfill.
 */
export async function snapshotsNeedingRubric(
  version: number,
  limit: number,
): Promise<
  {
    id: string;
    capturedAt: string;
    rubricVersion: number | null;
    signals: {
      present: boolean;
      headphones: boolean;
      eyesOnScreen: boolean;
      posture: SnapshotRow["posture"];
      note: string;
    };
  }[]
> {
  if (!hasPostgresConfig()) {
    return [];
  }
  const sql = await sqlClient();
  const result = await sql`
    SELECT id, captured_at, rubric_version, present, headphones, eyes_on_screen, posture, note
    FROM snapshots
    WHERE rubric_version IS DISTINCT FROM ${version} AND human_verified IS NOT TRUE
    ORDER BY captured_at ASC LIMIT ${limit}
  `;
  return result.rows.map((row) => ({
    id: String(row.id),
    capturedAt: new Date(row.captured_at as string | Date).toISOString(),
    rubricVersion:
      row.rubric_version == null ? null : Number(row.rubric_version),
    signals: {
      present: Boolean(row.present),
      headphones: Boolean(row.headphones),
      eyesOnScreen: Boolean(row.eyes_on_screen),
      posture: row.posture as SnapshotRow["posture"],
      note: String(row.note),
    },
  }));
}

/** How many snapshots still predate `version`. Postgres-only; 0 in local dev. */
export async function countSnapshotsNeedingRubric(version: number): Promise<number> {
  if (!hasPostgresConfig()) {
    return 0;
  }
  const sql = await sqlClient();
  const result = await sql`SELECT COUNT(*)::int AS n FROM snapshots WHERE rubric_version IS DISTINCT FROM ${version} AND human_verified IS NOT TRUE`;
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * One snapshot by id with all signals — needed to apply a human correction and
 * recompute its hour. Null when unknown.
 */
export async function getSnapshotById(id: string): Promise<SnapshotRow | null> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`SELECT * FROM snapshots WHERE id = ${id} LIMIT 1`;
    return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
  }
  const state = await readLocalState();
  return state.snapshots.find((snapshot) => snapshot.id === id) ?? null;
}

/**
 * Writes a human-corrected reading: updates the scored signals, note,
 * score/status and marks the row human_verified so the rubric backfill never
 * overwrites it. Human feedback is permanent ground truth.
 */
export async function correctSnapshot(id: string, signals: Signals, score: ScoreResult): Promise<void> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    await sql`
      UPDATE snapshots SET
        present = ${signals.present},
        headphones = ${signals.headphones},
        eyes_on_screen = ${signals.eyesOnScreen},
        note = ${signals.note},
        posture = ${signals.posture},
        score = ${score.score},
        status = ${score.status},
        human_verified = TRUE
      WHERE id = ${id}
    `;
    return;
  }
  const state = await readLocalState();
  const snapshot = state.snapshots.find((row) => row.id === id);
  if (snapshot) {
    Object.assign(snapshot, signals, score);
    await writeLocalState(state);
  }
}

/**
 * Records one human correction as a labeled example: which signal, the model's
 * value, and the human's value. The audit trail and the dataset a future
 * learning loop trains on. Postgres-only.
 */
export async function recordFeedback(input: { snapshotId: string; field: string; oldValue: string; newValue: string }): Promise<void> {
  if (!hasPostgresConfig()) {
    return;
  }
  const sql = await sqlClient();
  await sql`
    INSERT INTO feedback (id, snapshot_id, field, old_value, new_value)
    VALUES (${randomUUID()}, ${input.snapshotId}, ${input.field}, ${input.oldValue}, ${input.newValue})
  `;
}

/**
 * The human-corrected snapshots, newest first — the regression set for the
 * capture agent's misclassifications. A row is included the moment a human
 * correction marks it `human_verified`, so every correction auto-enrolls with no
 * extra bookkeeping. Postgres-only (returns [] in local dev, like feedback).
 *
 * `correctedFields` is the set of signals a human actually overrode (from the
 * feedback log), so an eval asserts ONLY human-truth fields and never treats a
 * still-model-authored signal on the same row as ground truth. Only rows with an
 * explicit feedback correction are returned: the owner-confirmed away-window path
 * (purge-gaming) marks rows human_verified WITHOUT a feedback row to encode a
 * not-working window (a person can be physically present but off-task), not a
 * presence-detector error — those are excluded so the eval judges the detector
 * against real physical-presence corrections only.
 */
export type CorrectionCase = {
  id: string;
  capturedAt: string;
  present: boolean;
  headphones: boolean;
  correctedFields: CorrectableField[];
};

export async function humanVerifiedCases(limit: number): Promise<CorrectionCase[]> {
  if (!hasPostgresConfig()) {
    return [];
  }
  const sql = await sqlClient();
  const result = await sql`
    SELECT s.id, s.captured_at, s.present, s.headphones,
      ARRAY_AGG(DISTINCT f.field) AS corrected_fields
    FROM snapshots s
    JOIN feedback f ON f.snapshot_id = s.id AND f.field IN ('present', 'headphones')
    WHERE s.human_verified IS TRUE
    GROUP BY s.id, s.captured_at, s.present, s.headphones
    ORDER BY s.captured_at DESC
    LIMIT ${limit}
  `;
  return result.rows.map((row) => {
    const logged = ((row.corrected_fields as string[] | null) ?? []).filter(
      (field): field is CorrectableField => (correctableFields as readonly string[]).includes(field),
    );
    return {
      id: String(row.id),
      capturedAt: new Date(row.captured_at as string | Date).toISOString(),
      present: Boolean(row.present),
      headphones: Boolean(row.headphones),
      correctedFields: logged,
    };
  });
}

/**
 * How many `human_verified` rows carry NO explicit correctable feedback — the
 * owner-confirmed not-working windows (purge-gaming). They are real corrections
 * and stay counted for visibility, but they encode off-task status rather than a
 * physical-presence detector error, so they are excluded from the detector eval
 * rather than scored as regressions. Postgres-only; 0 in local dev.
 */
export async function manualOverrideCaseCount(): Promise<number> {
  if (!hasPostgresConfig()) {
    return 0;
  }
  const sql = await sqlClient();
  const result = await sql`
    SELECT COUNT(*)::int AS n
    FROM snapshots s
    WHERE s.human_verified IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM feedback f WHERE f.snapshot_id = s.id AND f.field IN ('present', 'headphones')
      )
  `;
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Overwrites one snapshot's analysis with re-scored signals and stamps it with
 * `version` so the backfill never reprocesses it. Postgres-only.
 */
export async function updateSnapshotAnalysis(id: string, signals: Signals, score: ScoreResult, version: number): Promise<void> {
  if (!hasPostgresConfig()) {
    return;
  }
  const sql = await sqlClient();
  await sql`
    UPDATE snapshots SET
      present = ${signals.present},
      headphones = ${signals.headphones},
      eyes_on_screen = ${signals.eyesOnScreen},
      posture = ${signals.posture},
      note = ${signals.note},
      score = ${score.score},
      status = ${score.status},
      rubric_version = ${version}
    WHERE id = ${id}
  `;
}

/** Stamps the rubric version without changing the reading — for rows whose
 * thumbnail is gone, so the backfill stops retrying them. Postgres-only. */
export async function stampRubricVersion(id: string, version: number): Promise<void> {
  if (!hasPostgresConfig()) {
    return;
  }
  const sql = await sqlClient();
  await sql`UPDATE snapshots SET rubric_version = ${version} WHERE id = ${id}`;
}

/**
 * Distinct local days (YYYY-MM-DD) that have at least one hourly check-in,
 * newest first. Powers day navigation so it visits only days with data.
 */
export async function daysWithData(): Promise<string[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM hourly_checkins ORDER BY day DESC`;
    return result.rows.map((row) => String(row.day));
  }

  const state = await readLocalState();
  const unique = Array.from(new Set(state.hourlyCheckins.map((checkin) => checkin.day)));
  return unique.sort((left, right) => right.localeCompare(left));
}

/**
 * Per-day focus aggregates over the most recent `limit` days that have data,
 * newest first. Each day's `avgScore`/`presentPct` is the mean across its
 * recorded hourly check-ins **within the 8am–11pm scoring window** — hours
 * outside it never count toward the day's score. Days with no scoring-window
 * check-ins are absent (the caller renders them as empty cells).
 */
export async function dailyHistory(limit: number): Promise<DayHistory[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day,
             ROUND(AVG(avg_score))::int AS avg_score,
             ROUND(AVG(present_pct))::int AS present_pct,
             COUNT(*)::int AS hours
      FROM hourly_checkins
      WHERE hour >= ${scoringStartHour} AND hour < ${scoringEndHour}
      GROUP BY day
      ORDER BY day DESC
      LIMIT ${limit}
    `;
    return result.rows.map((row) => ({
      day: String(row.day),
      avgScore: Number(row.avg_score),
      presentPct: Number(row.present_pct),
      hours: Number(row.hours)
    }));
  }

  const state = await readLocalState();
  const byDay = new Map<string, HourlyCheckin[]>();
  for (const checkin of state.hourlyCheckins) {
    if (!isScoringHour(checkin.hour)) {
      continue;
    }
    const bucket = byDay.get(checkin.day);
    if (bucket) {
      bucket.push(checkin);
    } else {
      byDay.set(checkin.day, [checkin]);
    }
  }
  return Array.from(byDay.entries())
    .map(([day, checkins]) => ({
      day,
      avgScore: Math.round(checkins.reduce((total, c) => total + c.avgScore, 0) / checkins.length),
      presentPct: Math.round(checkins.reduce((total, c) => total + c.presentPct, 0) / checkins.length),
      hours: checkins.length
    }))
    .sort((left, right) => right.day.localeCompare(left.day))
    .slice(0, limit);
}

/**
 * Scoring-window hourly check-ins for the last `maxDays` days that have data,
 * newest day first then ascending hour. Powers the rolling 7/30-day averages,
 * which derive per-day headphones %, focus runs, and counts from these rows.
 */
export async function recentScoringHours(maxDays: number): Promise<HourlyCheckin[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, hour, avg_score, present_pct, headphones_pct, verdict, critical
      FROM hourly_checkins
      WHERE hour >= ${scoringStartHour} AND hour < ${scoringEndHour}
        AND day IN (SELECT DISTINCT day FROM hourly_checkins ORDER BY day DESC LIMIT ${maxDays})
      ORDER BY day DESC, hour ASC
    `;
    return result.rows.map(mapCheckin);
  }

  const state = await readLocalState();
  const scoring = state.hourlyCheckins.filter((checkin) => isScoringHour(checkin.hour));
  const recentDays = new Set(
    Array.from(new Set(scoring.map((checkin) => checkin.day)))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, maxDays)
  );
  return scoring
    .filter((checkin) => recentDays.has(checkin.day))
    .sort((left, right) => (left.day === right.day ? left.hour - right.hour : right.day.localeCompare(left.day)));
}

/**
 * Per-local-day scoring-window snapshot counts for the last `maxDays` days with
 * captures, newest first: `snapshots` is the total, `present` is the subset where
 * a person was in frame (drives hours-present). Local day/hour are derived in the
 * app timezone so the buckets match the hourly check-ins. Array = cache-serializable.
 */
export async function snapshotCountsByDay(
  maxDays: number
): Promise<{ day: string; snapshots: number; present: number }[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const tz = appTimeZone();
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (maxDays + 2));
    const result = await sql`
      SELECT day, COUNT(*)::int AS snapshots, COUNT(*) FILTER (WHERE present)::int AS present FROM (
        SELECT to_char(captured_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
               EXTRACT(HOUR FROM captured_at AT TIME ZONE ${tz})::int AS hour,
               present
        FROM snapshots
        WHERE captured_at >= ${since.toISOString()}
      ) frames
      WHERE hour >= ${scoringStartHour} AND hour < ${scoringEndHour}
      GROUP BY day
      ORDER BY day DESC
      LIMIT ${maxDays}
    `;
    return result.rows.map((row) => ({
      day: String(row.day),
      snapshots: Number(row.snapshots),
      present: Number(row.present)
    }));
  }

  const state = await readLocalState();
  const counts = new Map<string, { snapshots: number; present: number }>();
  for (const snapshot of state.snapshots) {
    const captured = new Date(snapshot.capturedAt);
    if (!isScoringHour(localHour(captured))) {
      continue;
    }
    const day = localDayKey(captured);
    const bucket = counts.get(day) ?? { snapshots: 0, present: 0 };
    bucket.snapshots += 1;
    if (snapshot.present) {
      bucket.present += 1;
    }
    counts.set(day, bucket);
  }
  return Array.from(counts.entries())
    .map(([day, bucket]) => ({ day, snapshots: bucket.snapshots, present: bucket.present }))
    .sort((left, right) => right.day.localeCompare(left.day))
    .slice(0, maxDays);
}

export async function saveHourlyCheckin(checkin: HourlyCheckin): Promise<HourlyCheckin> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      INSERT INTO hourly_checkins (day, hour, avg_score, present_pct, headphones_pct, verdict, critical)
      VALUES (${checkin.day}, ${checkin.hour}, ${checkin.avgScore}, ${checkin.presentPct}, ${checkin.headphonesPct}, ${checkin.verdict}, ${checkin.critical})
      ON CONFLICT (day, hour)
      DO UPDATE SET
        avg_score = EXCLUDED.avg_score,
        present_pct = EXCLUDED.present_pct,
        headphones_pct = EXCLUDED.headphones_pct,
        verdict = EXCLUDED.verdict
      RETURNING to_char(day, 'YYYY-MM-DD') AS day, hour, avg_score, present_pct, headphones_pct, verdict, critical
    `;
    return mapCheckin(result.rows[0]);
  }

  const state = await readLocalState();
  const existing = state.hourlyCheckins.find((entry) => entry.day === checkin.day && entry.hour === checkin.hour);
  const saved = { ...checkin, critical: existing?.critical ?? checkin.critical };
  state.hourlyCheckins = state.hourlyCheckins.filter(
    (entry) => entry.day !== checkin.day || entry.hour !== checkin.hour
  );
  state.hourlyCheckins.push(saved);
  state.hourlyCheckins.sort((left, right) => left.hour - right.hour);
  await writeLocalState(state);
  return saved;
}

/**
 * Marks an existing hourly check-in as critical or not critical without touching
 * the machine-derived rollup fields. Returns null when no captured hour exists.
 */
export async function setCriticalHour(day: string, hour: number, critical: boolean): Promise<HourlyCheckin | null> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      UPDATE hourly_checkins
      SET critical = ${critical}
      WHERE day = ${day} AND hour = ${hour}
      RETURNING to_char(day, 'YYYY-MM-DD') AS day, hour, avg_score, present_pct, headphones_pct, verdict, critical
    `;
    return result.rows[0] ? mapCheckin(result.rows[0]) : null;
  }

  const state = await readLocalState();
  const index = state.hourlyCheckins.findIndex((checkin) => checkin.day === day && checkin.hour === hour);
  if (index < 0) {
    return null;
  }
  const saved = { ...state.hourlyCheckins[index], critical };
  state.hourlyCheckins[index] = saved;
  await writeLocalState(state);
  return saved;
}

export async function hourlyForDay(day: string): Promise<HourlyCheckin[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, hour, avg_score, present_pct, headphones_pct, verdict, critical
      FROM hourly_checkins WHERE day = ${day} ORDER BY hour ASC
    `;
    return result.rows.map(mapCheckin);
  }

  const state = await readLocalState();
  return state.hourlyCheckins.filter((checkin) => checkin.day === day).sort((left, right) => left.hour - right.hour);
}

/**
 * Deletes one hourly rollup when its source snapshots have all been removed.
 * Returns true when a row existed. The caller owns deciding whether the hour
 * should instead be rebuilt from remaining snapshots.
 */
export async function deleteHourlyCheckin(day: string, hour: number): Promise<boolean> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      DELETE FROM hourly_checkins WHERE day = ${day} AND hour = ${hour}`;
    return (result.rowCount ?? 0) > 0;
  }

  const state = await readLocalState();
  const before = state.hourlyCheckins.length;
  state.hourlyCheckins = state.hourlyCheckins.filter((checkin) => checkin.day !== day || checkin.hour !== hour);
  await writeLocalState(state);
  return state.hourlyCheckins.length !== before;
}

/**
 * Counts stored rows that fall inside the overnight quiet window — snapshots by
 * their local capture hour, hourly rollups by their stored local hour. The
 * window itself is the single source of truth in lib/time.ts.
 */
export async function countQuietHourData(): Promise<{ snapshots: number; checkins: number }> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const tz = appTimeZone();
    const snap = await sql`
      SELECT count(*)::int AS n FROM snapshots
      WHERE EXTRACT(HOUR FROM captured_at AT TIME ZONE ${tz})::int >= ${quietHourStart}
        AND EXTRACT(HOUR FROM captured_at AT TIME ZONE ${tz})::int <  ${quietHourEnd}`;
    const chk = await sql`
      SELECT count(*)::int AS n FROM hourly_checkins
      WHERE hour >= ${quietHourStart} AND hour < ${quietHourEnd}`;
    return { snapshots: Number(snap.rows[0]?.n ?? 0), checkins: Number(chk.rows[0]?.n ?? 0) };
  }

  const state = await readLocalState();
  return {
    snapshots: state.snapshots.filter((s) => isQuietHour(localHour(new Date(s.capturedAt)))).length,
    checkins: state.hourlyCheckins.filter((c) => isQuietHour(c.hour)).length
  };
}

/**
 * Deletes every stored row inside the overnight quiet window and returns how many
 * were removed. Both tables are purged on purpose: leaving the snapshots would let
 * a backfill rebuild the quiet-hour rollups from them. Idempotent — re-running
 * deletes nothing once the window is clean.
 */
export async function purgeQuietHourData(): Promise<{ snapshots: number; checkins: number }> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const tz = appTimeZone();
    const chk = await sql`
      DELETE FROM hourly_checkins WHERE hour >= ${quietHourStart} AND hour < ${quietHourEnd}`;
    const snap = await sql`
      DELETE FROM snapshots
      WHERE EXTRACT(HOUR FROM captured_at AT TIME ZONE ${tz})::int >= ${quietHourStart}
        AND EXTRACT(HOUR FROM captured_at AT TIME ZONE ${tz})::int <  ${quietHourEnd}`;
    return { snapshots: snap.rowCount ?? 0, checkins: chk.rowCount ?? 0 };
  }

  const state = await readLocalState();
  const snapBefore = state.snapshots.length;
  const chkBefore = state.hourlyCheckins.length;
  state.snapshots = state.snapshots.filter((s) => !isQuietHour(localHour(new Date(s.capturedAt))));
  state.hourlyCheckins = state.hourlyCheckins.filter((c) => !isQuietHour(c.hour));
  await writeLocalState(state);
  return { snapshots: snapBefore - state.snapshots.length, checkins: chkBefore - state.hourlyCheckins.length };
}

export async function getSettings(): Promise<Settings> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`SELECT paused, blur, updated_at, snooze_until, nudge_state FROM settings WHERE id = 1`;
    const row = result.rows[0];
    return {
      paused: Boolean(row?.paused),
      blur: Boolean(row?.blur),
      updatedAt: new Date((row?.updated_at as string | Date | undefined) ?? Date.now()).toISOString(),
      snoozeUntil: row?.snooze_until ? new Date(row.snooze_until as string | Date).toISOString() : null,
      nudgeState: (row?.nudge_state as NudgeState | null) ?? null
    };
  }

  const settings = (await readLocalState()).settings;
  return { ...settings, snoozeUntil: settings.snoozeUntil ?? null, nudgeState: settings.nudgeState ?? null };
}

/**
 * Sets (or clears, with null) the instant until which ALL nudges are suppressed.
 * The 5-minute evaluator returns early while now < snoozeUntil. Idempotent.
 */
export async function setSnoozeUntil(iso: string | null): Promise<void> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    await sql`UPDATE settings SET snooze_until = ${iso}, updated_at = now() WHERE id = 1`;
    return;
  }

  await withLocalState((state) => {
    state.settings = { ...state.settings, snoozeUntil: iso, updatedAt: new Date().toISOString() };
  });
}

/**
 * Persists today's nudge bookkeeping (see NudgeState) on the settings row so the
 * 5-minute cron stays idempotent across invocations. Postgres stores it as JSONB.
 */
export async function setNudgeState(nudgeState: NudgeState): Promise<void> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    await sql`UPDATE settings SET nudge_state = ${JSON.stringify(nudgeState)}::jsonb, updated_at = now() WHERE id = 1`;
    return;
  }

  await withLocalState((state) => {
    state.settings = { ...state.settings, nudgeState, updatedAt: new Date().toISOString() };
  });
}

/**
 * Ledger entries (manual reachouts + feature-shipped flag) whose local day
 * falls in [fromDay, toDay] inclusive, ascending. Array = cache-serializable.
 */
export async function getLedgerEntries(fromDay: string, toDay: string): Promise<LedgerEntry[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, reachouts, feature_done, replies, meetings, commits, merges
      FROM scoreboard_entries WHERE day >= ${fromDay} AND day <= ${toDay} ORDER BY day
    `;
    return result.rows.map(mapLedgerEntry);
  }

  const state = await readLocalState();
  return (state.scoreboardEntries ?? [])
    .filter((entry) => entry.day >= fromDay && entry.day <= toDay)
    .sort((left, right) => left.day.localeCompare(right.day));
}

/**
 * Upserts one ledger day. A field left undefined is preserved (COALESCE in
 * Postgres, existing value locally), so a reachouts edit never clobbers the
 * feature flag and vice-versa. Returns the persisted row.
 */
export async function setLedgerEntry(
  day: string,
  fields: { reachouts?: number; featureDone?: boolean; replies?: number; meetings?: number; commits?: number; merges?: number }
): Promise<LedgerEntry> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      INSERT INTO scoreboard_entries (day, reachouts, feature_done, replies, meetings, commits, merges, updated_at)
      VALUES (${day}, ${fields.reachouts ?? 0}, ${fields.featureDone ?? false}, ${fields.replies ?? 0}, ${fields.meetings ?? 0}, ${fields.commits ?? 0}, ${fields.merges ?? 0}, now())
      ON CONFLICT (day) DO UPDATE SET
        reachouts    = COALESCE(${fields.reachouts ?? null}, scoreboard_entries.reachouts),
        feature_done = COALESCE(${fields.featureDone ?? null}, scoreboard_entries.feature_done),
        replies      = COALESCE(${fields.replies ?? null}, scoreboard_entries.replies),
        meetings     = COALESCE(${fields.meetings ?? null}, scoreboard_entries.meetings),
        commits      = COALESCE(${fields.commits ?? null}, scoreboard_entries.commits),
        merges       = COALESCE(${fields.merges ?? null}, scoreboard_entries.merges),
        updated_at   = now()
      RETURNING to_char(day, 'YYYY-MM-DD') AS day, reachouts, feature_done, replies, meetings, commits, merges
    `;
    return mapLedgerEntry(result.rows[0]);
  }

  return withLocalState((state) => {
    const entries = state.scoreboardEntries ?? [];
    const existing = entries.find((entry) => entry.day === day);
    const next: LedgerEntry = {
      day,
      reachouts: fields.reachouts ?? existing?.reachouts ?? 0,
      featureDone: fields.featureDone ?? existing?.featureDone ?? false,
      replies: fields.replies ?? existing?.replies ?? 0,
      meetings: fields.meetings ?? existing?.meetings ?? 0,
      commits: fields.commits ?? existing?.commits ?? 0,
      merges: fields.merges ?? existing?.merges ?? 0
    };
    state.scoreboardEntries = [...entries.filter((entry) => entry.day !== day), next].sort((left, right) =>
      left.day.localeCompare(right.day)
    );
    return next;
  });
}

/**
 * Appends one line to the two-way nudge conversation. Postgres assigns the UUID
 * and default timestamp; the local branch stamps both so the shapes match.
 * Append-only — there is no update or delete path (see plan: retention later).
 */
export async function appendNudgeMessage(m: { direction: "out" | "in"; kind: string; text: string }): Promise<void> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    await sql`
      INSERT INTO nudge_messages (id, direction, kind, text)
      VALUES (${randomUUID()}, ${m.direction}, ${m.kind}, ${m.text})
    `;
    return;
  }

  await withLocalState((state) => {
    const messages = state.nudgeMessages ?? [];
    messages.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      direction: m.direction,
      kind: m.kind,
      text: m.text
    });
    state.nudgeMessages = messages;
  });
}

/**
 * The most recent `limit` nudge-conversation lines, newest first. Array =
 * cache-serializable for the ledger page.
 */
export async function getRecentNudgeMessages(limit: number): Promise<NudgeMessage[]> {
  if (hasPostgresConfig()) {
    const sql = await sqlClient();
    const result = await sql`
      SELECT id, created_at, direction, kind, text
      FROM nudge_messages ORDER BY created_at DESC LIMIT ${limit}
    `;
    return result.rows.map(mapNudgeMessage);
  }

  const state = await readLocalState();
  return (state.nudgeMessages ?? [])
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}
