// TEMPORARY (benchmark tooling): stores HUMAN-LABELLED gold cases for the
// vision-model benchmark, either captured live from the webcam or from a fixture
// image. Delete when the benchmark is done.
//
// Why this bypasses /api/browser-capture: that endpoint returns 423 during quiet
// hours (1am-8am), and we want a labelled set now. Frames are reduced with the
// SAME toThumbnail() production uses, so the benchmark measures the exact image
// the real pipeline would send to a model.
//
// Usage:
//   bun scripts/_label-session.ts --count 8 --headphones true [--interval 3]
//   bun scripts/_label-session.ts --fixture tests/fixtures/face.jpg --headphones false
import { unlink } from "node:fs/promises";
import { toThumbnail } from "@/lib/thumb";
import { scoreFrom } from "@/lib/score";
import { correctSnapshot, recordFeedback, saveSnapshot } from "@/lib/store";
import type { Signals } from "@/lib/types";

function arg(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

const fixture = arg("--fixture");
const count = fixture ? 1 : Number(arg("--count") ?? 8);
const headphones = arg("--headphones") === "true";
const intervalMs = Number(arg("--interval") ?? 3) * 1000;
const camera = arg("--camera") ?? process.env.WORK_LIVE_CAMERA_NAME ?? null;
const imagesnap = process.env.IMAGESNAP_BIN || "/opt/homebrew/bin/imagesnap";

console.log(
  fixture
    ? `labeling from fixture ${fixture}, headphones=${headphones}`
    : `labeling session: ${count} frames, headphones=${headphones}, camera=${camera ?? "(default)"}`
);

const ids: string[] = [];
for (let i = 0; i < count; i += 1) {
  let raw: Uint8Array;

  if (fixture) {
    raw = new Uint8Array(await Bun.file(fixture).arrayBuffer());
  } else {
    const path = `/tmp/label-frame-${Date.now()}-${i}.jpg`;
    const args = camera ? ["-d", camera, "-w", "2", path] : ["-w", "2", path];
    const proc = Bun.spawn([imagesnap, ...args], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;

    const file = Bun.file(path);
    if (!(await file.exists()) || file.size === 0) {
      console.log(`  frame ${i + 1}: CAPTURE FAILED`);
      continue;
    }
    raw = new Uint8Array(await file.arrayBuffer());
    await unlink(path).catch(() => {});
  }

  const thumbnail = await toThumbnail(raw, { blur: false });

  // The human-supplied label IS the stored signal; the feedback row below marks
  // it as human ground truth so the eval/benchmark treats it as gold.
  const signals: Signals = {
    present: true,
    headphones,
    eyesOnScreen: true,
    posture: "upright",
    note: `labeling session (headphones=${headphones})`
  };
  const score = scoreFrom(signals);
  const saved = await saveSnapshot({ signals, score, thumbnail, captureSource: "browser" });
  await correctSnapshot(saved.id, signals, score);
  await recordFeedback({ snapshotId: saved.id, field: "headphones", oldValue: "", newValue: String(headphones) });

  ids.push(saved.id);
  console.log(`  frame ${i + 1}: ${saved.id} (${thumbnail.length} bytes thumb)`);

  if (!fixture && i < count - 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

console.log(`\nstored ${ids.length} gold frames with headphones=${headphones}`);
console.log(ids.join(","));
process.exit(0);
