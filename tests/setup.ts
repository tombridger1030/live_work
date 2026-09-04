// Test isolation guard — loaded via bunfig.toml `[test] preload`, before any
// test file imports lib/store.ts.
//
// Why this must exist: store.ts resolves its data root ONCE at module load from
// WORK_LIVE_DATA_DIR, and Bun auto-loads .env.local, where that variable points
// at the real self-hosted store on the expansion drive. Every test resets state
// by deleting the DEFAULT path (`cwd/.work-live`), so with the override in place
// tests wrote to the drive while cleaning a directory that did not exist —
// leaving destructive routes (purge-afk-overflow, purge-gaming, backfill) to run
// against production. That deleted 214 real snapshots on 2026-07-27.
//
// Clearing the override restores the invariant the suite is written against:
// the directory tests write to is the same one they clean.
delete process.env.WORK_LIVE_DATA_DIR;
delete process.env.WORK_LIVE_POSTGRES_URL;

// Postgres config would point the same destructive routes at a real database, so
// a test run must never see one regardless of what .env.local carries.
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.POSTGRES_URL_NON_POOLING;
delete process.env.POSTGRES_HOST;
delete process.env.BLOB_READ_WRITE_TOKEN;

// Ledger reads may synchronize GitHub when repo + author are configured. Tests
// must never use the developer's Keychain credential or mutate real activity.
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_REPO;
delete process.env.GITHUB_AUTHOR;
