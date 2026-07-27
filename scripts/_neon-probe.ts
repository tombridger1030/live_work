// TEMPORARY: is the Neon history actually reachable, or still quota-suspended?
// Prints counts only — never the connection string. Delete after use.
import { Pool } from "pg";

const url = process.env.NEON_PROBE_URL;
if (!url) {
  throw new Error("NEON_PROBE_URL not set");
}

const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });

try {
  const totals = await pool.query(
    `SELECT COUNT(*)::int AS snapshots,
            COUNT(*) FILTER (WHERE human_verified IS TRUE)::int AS human_verified,
            MIN(captured_at) AS first_capture,
            MAX(captured_at) AS last_capture
     FROM snapshots`
  );
  console.log("snapshots:", totals.rows[0]);

  const feedback = await pool.query(
    `SELECT field, COUNT(*)::int AS n FROM feedback GROUP BY field ORDER BY n DESC`
  );
  console.log("feedback rows by field:", feedback.rows);

  const gold = await pool.query(
    `SELECT COUNT(DISTINCT s.id)::int AS gold_cases
     FROM snapshots s
     JOIN feedback f ON f.snapshot_id = s.id AND f.field IN ('present','headphones')
     WHERE s.human_verified IS TRUE`
  );
  console.log("gold cases (human-corrected present/headphones):", gold.rows[0]);

  const headphonesGold = await pool.query(
    `SELECT s.headphones, COUNT(*)::int AS n
     FROM snapshots s
     JOIN feedback f ON f.snapshot_id = s.id AND f.field = 'headphones'
     WHERE s.human_verified IS TRUE
     GROUP BY s.headphones`
  );
  console.log("headphones-corrected balance:", headphonesGold.rows);
} catch (err) {
  console.log("NEON UNREACHABLE:", (err as Error).message);
} finally {
  await pool.end();
}
process.exit(0);
