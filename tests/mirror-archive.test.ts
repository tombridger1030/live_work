import { expect, test } from "bun:test";
import sharp from "sharp";
import { archiveFrame, archiveIncludes, archiveIO, archivePath, cleanupArchive, listArchivedDays, readArchiveAsset } from "@/lib/mirror-archive";
import { buildMirrorDashboardCopy, publishMirror, readMirror, readLatestMirror } from "@/lib/mirror";
import { assembleLedger, dayRange } from "@/lib/ledger";
import { mirrorLedgerForToday } from "@/lib/mirror-ledger";
import { applyLedgerOverrides } from "@/lib/ledger-overrides";
import type { DashboardData } from "@/lib/dashboard";
import type { LedgerData } from "@/lib/ledger";

const now = new Date("2026-09-04T19:00:00Z");
function memoryStore() {
  const objects = new Map<string, string | Buffer>();
  const writes: string[] = [];
  const removed: string[] = [];
  const io: typeof archiveIO = {
    read: async (path) => {
      const body = objects.get(path);
      return body === undefined ? null : new Response(typeof body === "string" ? body : new Uint8Array(body));
    },
    exists: async (path) => objects.has(path),
    write: async (path, body, _type, overwrite) => {
      if (!overwrite && objects.has(path)) throw new Error("already exists");
      writes.push(path); objects.set(path, body);
    },
    paths: async (prefix = "") => [...objects.keys()].filter((path) => path.startsWith(prefix)),
    remove: async (path) => { removed.push(path); objects.delete(path); },
  };
  return { io, objects, writes, removed };
}

function dashboard(day = "2026-09-03"): DashboardData {
  return { viewDay: day, today: day, isToday: true, dataDays: [day], latest: null,
    settings: { paused: false }, hourlyFrames: {}, hourly: [], defaultHour: null } as unknown as DashboardData;
}

test("archive window uses real local today and 30 calendar dates including DST", () => {
  expect(archiveIncludes("2026-08-06", now)).toBe(true);
  expect(archiveIncludes("2026-08-05", now)).toBe(false);
  expect(archiveIncludes("2026-09-05", now)).toBe(false);
  expect(archiveIncludes("2026-02-30", now)).toBe(false);
  expect(archiveIncludes("2026-10-05", new Date("2026-11-03T20:00:00Z"))).toBe(true);
  expect(archiveIncludes("2026-09-04", new Date("2026-09-04T01:00:00Z"))).toBe(false);
});

test("historical read is exact, rebases today and navigation, missing today never falls back", async () => {
  const { io, objects } = memoryStore();
  objects.set(archivePath("2026-09-03"), JSON.stringify({ publishedAt: now.toISOString(), data: dashboard() }));
  objects.set(archivePath("2026-09-02"), JSON.stringify({ publishedAt: now.toISOString(), data: dashboard("2026-09-02") }));
  objects.set("mirror/dashboard.json", JSON.stringify({ data: dashboard() }));
  const result = await readMirror("2026-09-03", now, io);
  expect(result?.data.viewDay).toBe("2026-09-03");
  expect(result?.data.today).toBe("2026-09-04");
  expect(result?.data.isToday).toBe(false);
  expect(result?.data.statusState.stale).toBe(true);
  expect(result?.data.prevDay).toBe("2026-09-02");
  expect(result?.data.dataDays).toEqual(["2026-09-03", "2026-09-02"]);
  expect(await readMirror(undefined, now, io)).toBeNull();
  expect(await readMirror("2026-09-01", now, io)).toBeNull();
  expect(await readMirror("../../dashboard", now, io)).toBeNull();
  objects.set(archivePath("2026-09-04"), JSON.stringify({ data: dashboard() }));
  expect(await readMirror(undefined, now, io)).toBeNull();
});

test("publish archives historical days without replacing latest mirror or overlays", async () => {
  const { io, objects, writes } = memoryStore();
  objects.set("mirror/dashboard.json", "latest sentinel");
  objects.set("mirror/dashboard-overrides.json", "correction sentinel");
  expect(await publishMirror(dashboard(), undefined as unknown as LedgerData, now, io)).toBe(true);
  expect(writes).toEqual([archivePath("2026-09-03")]);
  expect(objects.get("mirror/dashboard.json")).toBe("latest sentinel");
  expect(objects.get("mirror/dashboard-overrides.json")).toBe("correction sentinel");
  expect(await publishMirror(dashboard("2026-09-04"), undefined as unknown as LedgerData, now, io)).toBe(true);
  expect(writes.slice(-2)).toEqual([archivePath("2026-09-04"), "mirror/dashboard.json"]);
  expect(await publishMirror(dashboard("2026-08-05"), undefined as unknown as LedgerData, now, io)).toBe(false);
  const legacy = objects.get("mirror/dashboard.json");
  expect(await publishMirror(dashboard("2026-09-04"), undefined as unknown as LedgerData, now, io, { archiveOnly: true })).toBe(true);
  expect(objects.get("mirror/dashboard.json")).toBe(legacy);
  expect(writes.at(-1)).toBe(archivePath("2026-09-04"));
});

test("rollout fallback matches only requested day; latest read survives midnight without listing", async () => {
  const { io, objects } = memoryStore();
  const ledger = assembleLedger(dayRange("2026-08-31", "2026-09-06"), new Map(), new Map(), "2026-09-03", "2026-08-31");
  objects.set("mirror/dashboard.json", JSON.stringify({ publishedAt: "2026-09-03T23:00:00Z", data: dashboard(), ledger }));
  expect((await readMirror("2026-09-03", now, io))?.data.viewDay).toBe("2026-09-03");
  expect(await readMirror(undefined, now, io)).toBeNull();
  io.paths = async () => { throw new Error("must not list"); };
  const latest = await readLatestMirror(now, io);
  expect(latest?.ledger?.today).toBe("2026-09-04");
  expect(latest?.ledger?.days.find((day) => day.day === "2026-09-04")?.inRange).toBe(true);
  expect(latest?.data.isToday).toBe(false);
  expect(latest?.data.statusState.stale).toBe(true);
  expect(latest?.publishedAt).toBe("2026-09-03T23:00:00Z");
});

test("stale Ledger grows into next week before applying today's and new-week overrides", () => {
  const ledger = assembleLedger(dayRange("2026-08-31", "2026-09-06"), new Map(), new Map(), "2026-09-03", "2026-08-31");
  const current = applyLedgerOverrides(mirrorLedgerForToday(ledger, "2026-09-07"), {
    days: { "2026-09-07": { reachouts: 42 } }, weeks: { "2026-09-07": { reachouts: 300, hours: 50 } },
  });
  expect(current.today).toBe("2026-09-07");
  expect(current.days.find((day) => day.day === current.today)?.reachouts).toBe(42);
  expect(current.days.find((day) => day.day === current.today)?.hours).toBe(0);
  expect(current.weeks.at(-1)?.reachoutsTarget).toBe(300);
  expect(ledger.today).toBe("2026-09-03");
});

test("compact image stored once across repeated publishes, publicly served without Blob URL", async () => {
  const { io, objects, writes } = memoryStore();
  const original = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#387aff" } }).png().toBuffer();
  let reads = 0;
  const source = async () => { reads++; return original; };
  expect(await archiveFrame("2026-09-03", "snapshot-1", source, io)).toBe("/mirror-assets/2026-09-03/snapshot-1");
  await archiveFrame("2026-09-03", "snapshot-1", source, io);
  expect(reads).toBe(1);
  expect(writes).toHaveLength(1);
  const bytes = objects.get(archivePath("2026-09-03", "snapshot-1")) as Buffer;
  expect((await sharp(bytes).metadata()).width).toBe(512);
  expect(bytes.length).toBeLessThan(original.length);
  const response = await readArchiveAsset("2026-09-03", "snapshot-1", now, io);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
  expect((await readArchiveAsset("2026-09-03", "missing", now, io)).status).toBe(404);
  expect((await readArchiveAsset("2026-09-03", "../dashboard", now, io)).status).toBe(404);
  expect((await readArchiveAsset("2026-08-05", "snapshot-1", now, io)).status).toBe(404);
});

test("missing and undecodable images remain honestly unavailable and retryable", async () => {
  const { io, writes } = memoryStore();
  expect(await archiveFrame("2026-09-03", "missing", async () => null, io)).toBe("");
  expect(await archiveFrame("2026-09-03", "broken", async () => Buffer.from("broken"), io)).toBe("");
  expect(writes).toEqual([]);
});

test("storage failure cannot advertise a successful day or image; reads fail unavailable", async () => {
  const { io, objects } = memoryStore();
  io.write = async () => { throw new Error("offline"); };
  expect(await publishMirror(dashboard(), undefined as unknown as LedgerData, now, io)).toBe(false);
  expect(objects.size).toBe(0);
  io.read = async () => { throw new Error("offline"); };
  expect(await readMirror("2026-09-03", now, io)).toBeNull();
  expect((await readArchiveAsset("2026-09-03", "frame", now, io)).status).toBe(503);
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  await expect(archiveFrame("2026-09-03", "frame", async () => bytes, io)).rejects.toThrow("offline");
});

test("retention dry-run and apply only target expired recognized archive objects", async () => {
  const { io, objects, removed } = memoryStore();
  const expired = [archivePath("2026-08-05"), archivePath("2026-08-05", "old")];
  const preserved = [archivePath("2026-08-06"), archivePath("2026-09-05"),
    "mirror/dashboard.json", "mirror/dashboard-overrides.json", "mirror/ledger-overrides.json",
    "mirror/archive/2026-08-05/unknown.json", "mirror/archive/2026-02-30/dashboard.json"];
  for (const path of [...expired, ...preserved]) objects.set(path, "{}");
  expect(await cleanupArchive({ now }, io)).toEqual(expired);
  expect(removed).toEqual([]);
  expect(await cleanupArchive({ now, dryRun: false }, io)).toEqual(expired);
  expect(removed).toEqual(expired);
  expect([...objects.keys()]).toEqual(preserved);
  expect(await listArchivedDays(now, io)).toEqual(["2026-08-06"]);
});

test("1000 frames across all hours retain asset references with one resolution per id", async () => {
  const data = dashboard();
  for (let index = 0; index < 1000; index++) {
    const hour = index % 24;
    (data.hourlyFrames[hour] ??= []).push({ id: `frame-${index}`, thumbUrl: "data:image/jpeg;base64,giant" } as never);
  }
  data.latest = data.hourlyFrames[0][0];
  let resolutions = 0;
  let active = 0;
  let peak = 0;
  const copy = await buildMirrorDashboardCopy(data, async (id) => {
    resolutions++; active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return `/mirror-assets/2026-09-03/${id}`;
  });
  expect(resolutions).toBe(1000);
  expect(peak).toBe(6);
  expect(Object.values(copy.hourlyFrames).flat().filter((frame) => frame.thumbUrl)).toHaveLength(1000);
  expect(JSON.stringify(copy)).not.toContain("data:image");
  expect(Buffer.byteLength(JSON.stringify(copy))).toBeLessThan(100_000);
});

test("archive date listing scans only final day manifests, never frame or old-layout paths", async () => {
  const { io, objects } = memoryStore();
  expect(archivePath("2026-09-03")).toBe("mirror/archive/days/2026-09-03.json");
  objects.set(archivePath("2026-09-03"), "{}");
  objects.set(archivePath("2026-09-03", "frame"), "image");
  objects.set("mirror/archive/2026-09-02/dashboard.json", "{}");
  const prefixes: string[] = [];
  const paths = io.paths;
  io.paths = async (prefix) => { prefixes.push(prefix!); return paths(prefix); };
  expect(await listArchivedDays(now, io)).toEqual(["2026-09-03"]);
  expect(prefixes).toEqual(["mirror/archive/days/"]);
});
