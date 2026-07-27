// Compatibility adapter that replaces `@vercel/postgres` (the Neon serverless
// WebSocket driver) with a standard `pg` connection, so the app can run on any
// plain Postgres — currently a dedicated free-tier Supabase project.
//
// The exported `sql` keeps the EXACT surface the codebase already relies on, so
// callers in `lib/store.ts` and `lib/rate-limit.ts` change only their import
// path, not their code:
//   - tagged template:  await sql`SELECT ... ${value}`  -> { rows, rowCount }
//   - parameterized:    await sql.query("... $1", [v])   -> { rows, rowCount }
//
// This is the single place the database driver lives (information hiding): the
// next provider swap edits only this file. `pg`'s native result shape is already
// `{ rows, rowCount }`, which is why no call site needs per-query translation.
//
// Why `pg` and not the Neon serverless driver: Supabase exposes standard
// Postgres over its Supavisor pooler, not Neon's WebSocket protocol. `pg` core
// is pure JS and opens no socket on import; the pool is created on first query,
// so importing this module has no side effect when the local JSON store is used.

import { Pool } from "pg";
import { getOptionalEnv, requireEnv } from "@/lib/env";

export type SqlResult = { rows: Record<string, unknown>[]; rowCount: number };

// Created on first query (never at import). Callers only reach a query when
// `hasPostgresConfig()` is true, so this never throws in local/JSON mode.
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    // `WORK_LIVE_POSTGRES_URL` takes precedence over `POSTGRES_URL` so we can
    // point at Supabase without fighting the Neon Vercel integration, which owns
    // (and would re-inject) `POSTGRES_URL`. Setting one unmanaged var is the
    // whole cutover, and the old Neon vars stay intact for a future export.
    const connectionString = getOptionalEnv("WORK_LIVE_POSTGRES_URL") ?? requireEnv("POSTGRES_URL");
    pool = new Pool({
      connectionString,
      // One socket per warm serverless instance; Supabase's transaction pooler
      // multiplexes across instances, so a larger local pool only wastes slots.
      max: 1,
      // TLS to the remote pooler (Supabase) with relaxed CA verification — the
      // weakest security point here; tighten later by supplying Supabase's CA.
      // An explicit `?sslmode=disable` in the URL opts out (e.g. local Postgres).
      ssl: /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

// Assembles a tagged-template query into a parameterized `$1, $2, ...` statement
// — every interpolated value is bound as a parameter, never spliced into SQL —
// then executes it.
async function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> {
  let text = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    text += `$${i + 1}${strings[i + 1]}`;
  }
  const result = await getPool().query(text, values as unknown[]);
  return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
}

// node-postgres-style escape hatch for the one call site that needs an explicit
// parameter type cast (deleteSnapshotsByIds: `ANY($1::text[])`).
async function query(text: string, params?: unknown[]): Promise<SqlResult> {
  const result = await getPool().query(text, params as unknown[] | undefined);
  return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
}

export type Sql = typeof tagged & { query: typeof query };

export const sql: Sql = Object.assign(tagged, { query });
