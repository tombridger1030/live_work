import { deleteSnapshotsByIds, snapshotsForDay, saveHourlyCheckin } from "@/lib/store";
import { buildHourlyCheckin } from "@/lib/rollup";
import { localDayKey, localHour } from "@/lib/time";
import { revalidateCaptures } from "@/lib/cache";

// Purge yesterday's (2026-06-26) absent snapshots from 5:23pm to midnight
// These were captured when the webcam was disconnected (gaming on PC, not at Mac setup)

const targetDay = "2026-06-26";
const cutoffHour = 17; // 5pm
const cutoffMinute = 23;

console.log(`Purging absent snapshots from ${targetDay} after ${cutoffHour}:${cutoffMinute}...`);

const snapshots = await snapshotsForDay(targetDay);
console.log(`Found ${snapshots.length} total snapshots for ${targetDay}`);

// Filter: present=false (webcam disconnected) AND time >= 17:23
const toDelete = snapshots.filter((snapshot) => {
  if (snapshot.present) return false; // only absent snapshots

  const capturedAt = new Date(snapshot.capturedAt);
  const hour = localHour(capturedAt);
  const minute = capturedAt.getMinutes();

  // Include if hour > 17, or hour === 17 and minute >= 23
  if (hour > cutoffHour) return true;
  if (hour === cutoffHour && minute >= cutoffMinute) return true;
  return false;
});

console.log(`Found ${toDelete.length} absent snapshots to delete`);

if (toDelete.length === 0) {
  console.log("Nothing to delete");
  process.exit(0);
}

// Group by hour for rebuilding rollups
const affectedHours = new Set<number>();
for (const snapshot of toDelete) {
  affectedHours.add(localHour(new Date(snapshot.capturedAt)));
}

console.log(`Affected hours: ${Array.from(affectedHours).sort((a, b) => a - b).join(", ")}`);

// Delete snapshots
const deleted = await deleteSnapshotsByIds(toDelete.map((s) => s.id));
console.log(`Deleted ${deleted} snapshots`);

// Rebuild affected hourly checkins from remaining snapshots
const remaining = await snapshotsForDay(targetDay);
for (const hour of affectedHours) {
  const hourSnapshots = remaining.filter((s) => localHour(new Date(s.capturedAt)) === hour);
  if (hourSnapshots.length > 0) {
    const checkin = buildHourlyCheckin(targetDay, hour, hourSnapshots);
    await saveHourlyCheckin(checkin);
    console.log(`Rebuilt hour ${hour}: ${hourSnapshots.length} snapshots, score=${checkin.avgScore}`);
  } else {
    console.log(`Hour ${hour} has no remaining snapshots`);
  }
}

await revalidateCaptures();
console.log("Done. Cache revalidated.");
