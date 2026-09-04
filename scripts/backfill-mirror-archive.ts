import "next/dist/server/node-environment-baseline";
import { IncrementalCache } from "next/dist/server/lib/incremental-cache";
import { archiveIncludes, cleanupArchive } from "@/lib/mirror-archive";
import { isValidDayKey } from "@/lib/time";

// Read-only by default. --apply authorizes archive writes; --cleanup separately
// selects retention deletion. Neither operation changes local capture records.
const args = process.argv.slice(2);
const allowed = new Set(["--apply", "--dry-run", "--cleanup", "--archive-only"]);
for (const arg of args) {
  if (!allowed.has(arg) && !arg.startsWith("--day=")) throw new Error(`Unknown argument: ${arg}`);
}
if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("Choose --apply or --dry-run");
if (process.env.VERCEL) throw new Error("Run archive maintenance on the capture Mac");
const dryRun = !args.includes("--apply");
const archiveOnly = args.includes("--archive-only");
const now = new Date();
const day = args.find((arg) => arg.startsWith("--day="))?.slice(6);
if (day !== undefined && (!isValidDayKey(day) || !archiveIncludes(day, now))) throw new Error("Day must be inside the 30-day archive window");

if (args.includes("--cleanup")) {
  if (archiveOnly) throw new Error("--archive-only applies to backfill, not cleanup");
  if (day) throw new Error("Cleanup covers the archive retention window; omit --day");
  const paths = await cleanupArchive({ dryRun, now });
  console.log(JSON.stringify({ operation: "cleanup", dryRun, paths }, null, 2));
} else {
  // Reuse the dashboard assembler outside Next requests with a non-persistent
  // cache. No .next cache or capture files are written by this adapter.
  Object.assign(globalThis, { __incrementalCache: new IncrementalCache({
    dev: false, requestHeaders: {}, flushToDisk: false,
    getPrerenderManifest: () => ({ version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [],
      preview: { previewModeId: "archive-cli", previewModeSigningKey: "", previewModeEncryptionKey: "" } }),
  }) });
  // Ledger assembly must not kick off unrelated GitHub synchronization.
  delete process.env.GITHUB_REPO;
  const { daysWithData, snapshotThumbnailBytes } = await import("@/lib/store");
  const days = (await daysWithData()).filter((candidate) => archiveIncludes(candidate, now) && (!day || candidate === day));
  if (day && days.length === 0) throw new Error("No local captures for requested day");
  if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN required for --apply");
  const { getDashboardData } = await import("@/lib/dashboard");
  const { getLedgerData } = await import("@/lib/ledger-server");
  const { publishMirror } = await import("@/lib/mirror");
  const ledger = dryRun ? undefined : await getLedgerData(now);
  const sharp = (await import("sharp")).default;
  const totals = { days: 0, frames: 0, available: 0, unavailable: 0, undecodable: 0 };
  for (const candidate of days) {
    const data = await getDashboardData(now, candidate);
    const frames = Object.values(data.hourlyFrames).flat();
    const coverage = { available: 0, unavailable: 0, undecodable: 0 };
    for (const frame of frames) {
      const bytes = await snapshotThumbnailBytes(frame.id);
      if (!bytes) { coverage.unavailable++; continue; }
      try {
        await sharp(Buffer.from(bytes), { failOn: "warning" }).resize({ width: 512, withoutEnlargement: true }).jpeg().toBuffer();
        coverage.available++;
      } catch { coverage.undecodable++; }
    }
    console.log(JSON.stringify({ day: candidate, dryRun, archiveOnly, hours: Object.keys(data.hourlyFrames).length,
      frames: frames.length, localImages: coverage }));
    totals.days++; totals.frames += frames.length;
    totals.available += coverage.available; totals.unavailable += coverage.unavailable; totals.undecodable += coverage.undecodable;
    if (!dryRun && !await publishMirror(data, ledger!, now, undefined, { archiveOnly })) throw new Error(`Archive publish failed: ${candidate}`);
  }
  console.log(JSON.stringify({ summary: totals, dryRun, archiveOnly }));
}
