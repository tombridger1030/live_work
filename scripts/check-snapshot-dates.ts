import { snapshotsSince } from "@/lib/store";
import { localDayKey, localHour } from "@/lib/time";

const snapshots = await snapshotsSince(new Date(0));
console.log(`Total snapshots: ${snapshots.length}`);

if (snapshots.length === 0) {
  console.log("No snapshots in database");
  process.exit(0);
}

// Group by day
const byDay = new Map<string, number>();
for (const snapshot of snapshots) {
  const day = localDayKey(new Date(snapshot.capturedAt));
  byDay.set(day, (byDay.get(day) || 0) + 1);
}

console.log("\nSnapshots by day:");
for (const [day, count] of Array.from(byDay.entries()).sort().reverse()) {
  console.log(`  ${day}: ${count}`);
}

// Show recent snapshots (last 20)
console.log("\nRecent snapshots:");
const recent = snapshots.slice(-20);
for (const snapshot of recent) {
  const dt = new Date(snapshot.capturedAt);
  const day = localDayKey(dt);
  const hour = localHour(dt);
  const minute = dt.getMinutes();
  console.log(`  ${day} ${hour}:${minute.toString().padStart(2, "0")} - present=${snapshot.present}, score=${snapshot.score}`);
}
