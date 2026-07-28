// How accurate was tally over a window, measured against the only ground truth
// that exists: the corrections Tom made.
//
// Every number here comes from data the app already records, so this can be run
// at any time without instrumenting anything further:
//   * a correction means the record was wrong and he had to fix it;
//   * `visionRead: "unknown"` means nothing examined the frame;
//   * `visionModel` names the model that answered, so accuracy is attributable —
//     and a model other than the first in the chain means the frame fell back
//     (the first was unsure or errored).
//
// Deliberately NOT a pass/fail gate. It reports rates so a judgement can be made
// on evidence rather than impression.
//
// Usage: WORK_LIVE_DATA_DIR=... bun run scripts/accuracy-report.ts [--days 7]
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HourlyCheckin, SnapshotRow } from "@/lib/types";

const daysArg = process.argv.indexOf("--days");
const days = daysArg === -1 ? 7 : Number(process.argv[daysArg + 1] ?? 7);
const dir = process.env.WORK_LIVE_DATA_DIR ?? path.join(process.cwd(), ".work-live");

type Feedback = { id: string; snapshotId: string; field: string; oldValue: string; newValue: string; createdAt: string };
type Store = { snapshots: SnapshotRow[]; hourlyCheckins: HourlyCheckin[]; feedback?: Feedback[] };
const store: Store = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));

const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
const frames = store.snapshots.filter((row) => row.capturedAt >= cutoff);
const byId = new Map(store.snapshots.map((row) => [row.id, row]));
const pct = (count: number, total: number) => (total === 0 ? "n/a" : `${Math.round((count / total) * 100)}%`);

console.log(`=== tally accuracy, last ${days} days ===\n`);

if (frames.length === 0) {
  console.log("no captures in the window");
  process.exit(0);
}

const present = frames.filter((row) => row.present);
const unknown = present.filter((row) => row.visionRead === "unknown");
console.log("CAPTURE");
console.log(`  frames                 ${frames.length}`);
console.log(`  at the desk            ${present.length} (${pct(present.length, frames.length)})`);
console.log(`  never examined         ${unknown.length} (${pct(unknown.length, present.length)} of desk frames)  <- vision outages`);

// Corrections are the ground truth: each one is the record having been wrong.
// Only the FIRST correction per snapshot+field counts, so re-edits are not
// double-charged against the model.
const first = new Map<string, Feedback>();
for (const entry of [...(store.feedback ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
  const key = `${entry.snapshotId}|${entry.field}`;
  if (!first.has(key)) first.set(key, entry);
}
const windowCorrections = [...first.values()].filter((entry) => {
  const frame = byId.get(entry.snapshotId);
  return frame !== undefined && frame.capturedAt >= cutoff;
});

console.log("\nCORRECTIONS YOU MADE (the accuracy signal)");
if (windowCorrections.length === 0) {
  console.log("  none — nothing needed fixing in this window");
} else {
  const byField = new Map<string, Feedback[]>();
  for (const entry of windowCorrections) {
    if (!byField.has(entry.field)) byField.set(entry.field, []);
    byField.get(entry.field)!.push(entry);
  }
  for (const [field, entries] of [...byField].sort((a, b) => b[1].length - a[1].length)) {
    const up = entries.filter((entry) => entry.oldValue === "false" && entry.newValue === "true").length;
    const down = entries.filter((entry) => entry.oldValue === "true" && entry.newValue === "false").length;
    console.log(`  ${field.padEnd(12)} ${String(entries.length).padStart(4)}  (missed ${up} / over-called ${down})`);
  }
  console.log(`  correction rate        ${pct(windowCorrections.length, frames.length)} of frames needed a fix`);
}

// Attribution: which model answered, and how often its answer stood.
console.log("\nBY ANSWERING MODEL");
const corrected = new Set(windowCorrections.map((entry) => entry.snapshotId));
const examined = present.filter((row) => row.visionRead !== "unknown" && row.visionModel);
if (examined.length === 0) {
  console.log("  no frames carry a model yet — visionModel records from this deploy forward");
} else {
  const byModel = new Map<string, SnapshotRow[]>();
  for (const row of examined) {
    const model = row.visionModel!;
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model)!.push(row);
  }
  for (const [model, rows] of [...byModel].sort((a, b) => b[1].length - a[1].length)) {
    const wrong = rows.filter((row) => corrected.has(row.id)).length;
    console.log(`  ${model.padEnd(34)} ${String(rows.length).padStart(4)} frames, ${String(wrong).padStart(3)} corrected (${pct(wrong, rows.length)} wrong)`);
  }
  console.log("  a model other than the first in the chain means the frame fell back");
}

console.log("\nOUTSTANDING");
const windowDays = new Set(frames.map((row) => row.capturedAt.slice(0, 10)));
const flagged = store.hourlyCheckins.filter((entry) => entry.unknownFrames > 0);
console.log(`  hours flagged incomplete (all time)  ${flagged.length}`);
console.log(`  ...of which fall in this window      ${flagged.filter((entry) => windowDays.has(entry.day)).length}`);
console.log(`  frames never examined (all time)     ${store.snapshots.filter((row) => row.visionRead === "unknown").length}`);
process.exit(0);
