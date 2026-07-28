// One-off migration: marks historical frames that no vision model ever examined.
//
// Before `visionRead` existed, a total provider failure stored `headphones: false`
// with an outage note, indistinguishable from a model looking and seeing none.
// This finds those rows and marks them `visionRead: "unknown"` so aggregates stop
// counting them as an explicit "no", then rebuilds every affected hourly rollup.
//
// Identification is conservative — a row is only marked when all three hold:
//   * its note is exactly one of the two outage notes capture writes;
//   * `headphones` is false, so it was never corrected upward;
//   * it is not human-verified, so Tom never asserted "no headphones" himself.
// A frame Tom corrected keeps his answer and stays "ok": human truth outranks
// the absence of a model read.
//
// Run with --apply; default is a dry run.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHourlyCheckin } from "@/lib/rollup";
import { localDayKey, localHour } from "@/lib/time";
import { VISION_CREDITS_NOTE, VISION_UNAVAILABLE_NOTE } from "@/lib/vision-notes";
import type { HourlyCheckin, SnapshotRow } from "@/lib/types";

const apply = process.argv.includes("--apply");
const dir = process.env.WORK_LIVE_DATA_DIR ?? path.join(process.cwd(), ".work-live");
const file = path.join(dir, "store.json");

type Store = { snapshots: SnapshotRow[]; hourlyCheckins: HourlyCheckin[] };
const store: Store = JSON.parse(await readFile(file, "utf8"));

const OUTAGE_NOTES = new Set<string>([VISION_UNAVAILABLE_NOTE, VISION_CREDITS_NOTE]);
const unexamined = (row: SnapshotRow) =>
  OUTAGE_NOTES.has(row.note ?? "") && row.headphones === false && row.humanVerified !== true;

const targets = store.snapshots.filter((row) => unexamined(row) && row.visionRead !== "unknown");
const alreadyCorrected = store.snapshots.filter(
  (row) => OUTAGE_NOTES.has(row.note ?? "") && !unexamined(row)
);

const mean = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0);
const presentBefore = store.snapshots.filter((row) => row.present);

console.log(`frames to mark unknown:            ${targets.length}`);
console.log(`outage frames left alone (human truth or already marked): ${alreadyCorrected.length}`);
console.log(`\ncurrent public numbers over ${presentBefore.length} present frames:`);
console.log(`  avg focus  ${mean(presentBefore.map((row) => row.score))}/100`);
console.log(`  headphones ${Math.round((presentBefore.filter((row) => row.headphones).length / presentBefore.length) * 100)}%`);

// Which hours will need rebuilding, and what they become.
const affected = new Map<string, Set<number>>();
for (const row of targets) {
  const at = new Date(row.capturedAt);
  const day = localDayKey(at);
  if (!affected.has(day)) affected.set(day, new Set());
  affected.get(day)!.add(localHour(at));
}
const hourCount = [...affected.values()].reduce((total, hours) => total + hours.size, 0);
console.log(`\nhours to rebuild: ${hourCount} across ${affected.size} days`);

if (!apply) {
  // Show the effect without writing: recompute as if the marks were applied.
  const marked = new Set(targets.map((row) => row.id));
  const examined = presentBefore.filter((row) => !marked.has(row.id));
  console.log(`\nafter the migration, over the ${examined.length} frames a model actually read:`);
  console.log(`  avg focus  ${mean(examined.map((row) => row.score))}/100`);
  console.log(`  headphones ${Math.round((examined.filter((row) => row.headphones).length / examined.length) * 100)}%`);
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

for (const row of targets) row.visionRead = "unknown";

const byHour = new Map<string, SnapshotRow[]>();
for (const row of store.snapshots) {
  const at = new Date(row.capturedAt);
  const key = `${localDayKey(at)}#${localHour(at)}`;
  if (!byHour.has(key)) byHour.set(key, []);
  byHour.get(key)!.push(row);
}

let rebuilt = 0;
for (const [day, hours] of affected) {
  for (const hour of hours) {
    const frames = byHour.get(`${day}#${hour}`) ?? [];
    if (frames.length === 0) continue;
    const fresh = buildHourlyCheckin(day, hour, frames);
    const index = store.hourlyCheckins.findIndex((entry) => entry.day === day && entry.hour === hour);
    if (index === -1) {
      store.hourlyCheckins.push(fresh);
    } else {
      // `critical` is human-set and must survive a rollup rebuild.
      store.hourlyCheckins[index] = { ...fresh, critical: store.hourlyCheckins[index].critical };
    }
    rebuilt += 1;
  }
}

// Any hour never touched by the migration still lacks the new field; fill it in
// from its own frames so no stored check-in carries an undefined count.
for (const checkin of store.hourlyCheckins) {
  if (typeof checkin.unknownFrames === "number") continue;
  const frames = byHour.get(`${checkin.day}#${checkin.hour}`) ?? [];
  checkin.unknownFrames = frames.filter((row) => row.visionRead === "unknown").length;
}

await writeFile(file, JSON.stringify(store));

const examined = store.snapshots.filter((row) => row.present && row.visionRead !== "unknown");
console.log(`\nmarked ${targets.length} frames | rebuilt ${rebuilt} hours`);
console.log(`new public numbers over ${examined.length} examined present frames:`);
console.log(`  avg focus  ${mean(examined.map((row) => row.score))}/100`);
console.log(`  headphones ${Math.round((examined.filter((row) => row.headphones).length / examined.length) * 100)}%`);
console.log(`hours now flagged incomplete: ${store.hourlyCheckins.filter((entry) => entry.unknownFrames > 0).length}`);
process.exit(0);
