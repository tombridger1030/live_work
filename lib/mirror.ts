import { archiveFrame, archiveIncludes, archiveIO, archivePath, listArchivedDays } from "@/lib/mirror-archive";
import { localDayKey } from "@/lib/time";
import { applyCodeDaysToLedger } from "@/lib/code-persistence";
import { publicStatusFor } from "@/lib/status";
import { mirrorLedgerForToday } from "@/lib/mirror-ledger";
import type { DashboardData } from "@/lib/dashboard";
import type { LedgerData } from "@/lib/ledger";
import { snapshotThumbnailBytes } from "@/lib/store";
import {
  applyDashboardOverrides,
  readDashboardOverrides,
} from "@/lib/dashboard-overrides";
import { applyLedgerOverrides, readLedgerOverrides } from "@/lib/ledger-overrides";

export { listArchivedDays } from "@/lib/mirror-archive";

/**
 * The always-on copy of the dashboard.
 *
 * tally is served from a Mac that sleeps, closes, and travels, so the public URL
 * dies with it. This module keeps one small copy of the rendered dashboard in
 * Vercel Blob, which is always up, so the link still answers when the Mac does
 * not.
 *
 * The Mac publishes capture state after every capture. Vercel reads that latest
 * snapshot and applies the separate owner-entered ledger overlay at read time,
 * so a Mac publish cannot erase a ledger edit made while the private route is
 * unreachable. The capture source remains local; the deployed Ledger is a
 * durable editing surface backed by the same private store.
 *
 * Daily documents reference immutable compact images for every captured hour.
 * Thirty calendar days are readable; maintenance removes expired archive objects.
 *
 * Blob credentials stay server-side. The dashboard and same-origin image route
 * intentionally permit public reads; private storage does not authenticate visitors.
 */

const MIRROR_PATHNAME = "mirror/dashboard.json";

export type MirrorSnapshot = {
  /** When the Mac published this copy (ISO 8601). Drives the staleness line in the UI. */
  publishedAt: string;
  /** Dashboard data with same-origin compact image references for all hours. */
  data: DashboardData;
  /** Ledger state from the same publish; absent only on pre-ledger mirror blobs. */
  ledger?: LedgerData;
};

/**
 * True when this process is the always-on deployment rather than the Mac.
 *
 * Same signal `next.config.ts` uses to decide whether to redirect, so the two
 * cannot disagree about which side of the mirror they are on.
 */
export function isMirrorHost(): boolean {
  return Boolean(process.env.VERCEL);
}

/**
 * Builds the dashboard data stored in the always-on mirror.
 *
 * Resolves every unique frame, including latest, exactly once. The resolver
 * returns a same-origin asset URL or empty string for missing bytes. Input is
 * never mutated. Six workers bound image memory and network concurrency.
 */
export async function buildMirrorDashboardCopy(
  data: DashboardData,
  frameUrlFor: (id: string) => Promise<string>,
): Promise<DashboardData> {
  const frameIds = new Set<string>();
  for (const frame of Object.values(data.hourlyFrames).flat()) {
    frameIds.add(frame.id);
  }
  if (data.latest) {
    frameIds.add(data.latest.id);
  }

  const urls = new Map<string, string>();
  const pending = [...frameIds];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
    while (cursor < pending.length) {
      const id = pending[cursor++];
      urls.set(id, await frameUrlFor(id));
    }
  }));
  const withMirrorUrl = <T extends { id: string; thumbUrl: string }>(
    row: T,
  ): T => ({
    ...row,
    thumbUrl: urls.get(row.id) ?? "",
  });
  const hourlyFrames: DashboardData["hourlyFrames"] = {};
  for (const [hour, frames] of Object.entries(data.hourlyFrames)) {
    hourlyFrames[Number(hour)] = frames.map(withMirrorUrl);
  }
  return {
    ...data,
    latest: data.latest ? withMirrorUrl(data.latest) : null,
    hourlyFrames,
  };
}

/**
 * Publishes the current dashboard so the public URL can answer while the Mac is
 * away. Call after data changes; the newest publish wins.
 *
 * Best-effort by contract: returns false and never throws when the mirror is not
 * configured or the upload fails. A capture must never fail because the copy of
 * it could not be uploaded, and the mirror host must never publish (it would
 * overwrite real data with whatever empty store it has).
 *
 * @param data exact day to archive; all hours receive compact image assets
 * @param ledger current Ledger state copied without image assets
 * @param now  publish timestamp, injectable for tests
 * @returns whether the copy actually landed
 */
export async function publishMirror(
  data: DashboardData,
  ledger: LedgerData,
  now = new Date(),
  io = archiveIO,
  { archiveOnly = false }: { archiveOnly?: boolean } = {},
): Promise<boolean> {
  if (isMirrorHost() || (io === archiveIO && !process.env.BLOB_READ_WRITE_TOKEN)) {
    return false;
  }
  try {
    if (!archiveIncludes(data.viewDay, now)) return false;
    const frames = new Map(Object.values(data.hourlyFrames).flat().map((frame) => [frame.id, frame]));
    if (data.latest) frames.set(data.latest.id, data.latest);
    const snapshot: MirrorSnapshot = {
      publishedAt: now.toISOString(),
      data: await buildMirrorDashboardCopy(data, (id) => {
        const day = localDayKey(new Date(frames.get(id)!.capturedAt));
        return archiveIncludes(day, now)
          ? archiveFrame(day, id, () => snapshotThumbnailBytes(id), io)
          : Promise.resolve("");
      }),
      ledger,
    };
    const body = JSON.stringify(snapshot);
    await io.write(archivePath(data.viewDay), body, "application/json", true);
    if (!archiveOnly && data.viewDay === localDayKey(now)) {
      await io.write(MIRROR_PATHNAME, body, "application/json", true);
    }
    return true;
  } catch (error) {
    console.error("[work-live] Could not publish the offline mirror", error);
    return false;
  }
}

// At most one publish runs at a time; a request arriving mid-publish sets this
// flag instead of starting a second one, so a burst of changes (a purge sweep
// rewriting many rows) collapses into one more upload rather than one per row.
let publishInFlight: Promise<void> | null = null;
let publishAgainWhenDone = false;

async function publishLatest(): Promise<void> {
  const [{ getDashboardData }, { getLedgerData }] = await Promise.all([
    import("@/lib/dashboard"),
    import("@/lib/ledger-server"),
  ]);
  const [dashboard, ledger] = await Promise.all([
    getDashboardData(),
    getLedgerData(),
  ]);
  await publishMirror(dashboard, ledger);
}

/**
 * Refreshes the published copy in the background because the underlying data
 * changed. Returns immediately; the upload is deliberately not awaited so no
 * capture or correction waits on the network.
 *
 * Safe to call on every change: concurrent calls coalesce, and it is a no-op on
 * the mirror host and when no store is configured.
 */
export function refreshMirrorSoon(): void {
  if (isMirrorHost() || !process.env.BLOB_READ_WRITE_TOKEN) {
    return;
  }
  if (publishInFlight) {
    publishAgainWhenDone = true;
    return;
  }
  const settle = (): void => {
    publishInFlight = null;
    if (publishAgainWhenDone) {
      publishAgainWhenDone = false;
      refreshMirrorSoon();
    }
  };
  publishInFlight = publishLatest().then(settle, (error) => {
    console.error("[work-live] Could not refresh the offline mirror", error);
    settle();
  });
}

/**
 * Reads exactly day (default: actual local today), or null when there is none
 * (never published, misconfigured, or unreadable). Callers must handle null by
 * showing that the mirror is empty rather than by failing the page: an offline
 * Mac plus a hard error would take the URL down for the exact reason the mirror
 * exists to prevent.
 */
export async function readMirror(day?: string, now = new Date(), io = archiveIO): Promise<MirrorSnapshot | null> {
  if (io === archiveIO && !process.env.BLOB_READ_WRITE_TOKEN) {
    return null;
  }
  try {
    const today = localDayKey(now);
    const requestedDay = day ?? today;
    if (!archiveIncludes(requestedDay, now)) return null;
    // useCache: false — a mirror that serves a cached copy of a copy would show
    // an hours-old page with a fresh-looking timestamp.
    const result = await io.read(archivePath(requestedDay)) ?? await io.read(MIRROR_PATHNAME);
    if (!result) {
      return null;
    }
    const snapshot = JSON.parse(
      await result.text(),
    ) as MirrorSnapshot;
    if (snapshot.data.viewDay !== requestedDay) return null;
    snapshot.data.dataDays = await listArchivedDays(now, io);
    if (!snapshot.data.dataDays.includes(requestedDay)) snapshot.data.dataDays.push(requestedDay);
    snapshot.data.dataDays.sort().reverse();
    snapshot.data.prevDay = snapshot.data.dataDays.find((candidate) => candidate < requestedDay) ?? null;
    snapshot.data.nextDay = snapshot.data.dataDays.filter((candidate) => candidate > requestedDay).sort()[0] ?? null;
    return await applyMirrorReadState(snapshot, now);
  } catch (error) {
    console.error("[work-live] Could not read the offline mirror", error);
    return null;
  }
}

/**
 * Last capture publication, regardless of day/retention. For Ledger and status,
 * never for a requested dashboard day. Camera downtime cannot prevent editing:
 * rebuilds Ledger through actual today before applying current owner overrides.
 * Returns null on missing/corrupt storage. Does not list archive assets or dates.
 */
export async function readLatestMirror(now = new Date(), io = archiveIO): Promise<MirrorSnapshot | null> {
  if (io === archiveIO && !process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const response = await io.read(MIRROR_PATHNAME);
    if (!response) return null;
    return await applyMirrorReadState(await response.json() as MirrorSnapshot, now);
  } catch (error) {
    console.error("[work-live] Could not read latest mirror", error);
    return null;
  }
}

async function applyMirrorReadState(snapshot: MirrorSnapshot, now: Date): Promise<MirrorSnapshot> {
  const today = localDayKey(now);
  if (snapshot.ledger) snapshot.ledger = applyLedgerOverrides(
    mirrorLedgerForToday(snapshot.ledger, today), await readLedgerOverrides(),
  );
  if (snapshot.ledger && isMirrorHost()) snapshot.ledger = await applyCodeDaysToLedger(snapshot.ledger);
  snapshot.data = applyDashboardOverrides(snapshot.data, await readDashboardOverrides());
  snapshot.data.today = today;
  snapshot.data.isToday = snapshot.data.viewDay === today;
  snapshot.data.statusState = publicStatusFor(snapshot.data.latest, snapshot.data.settings, now);
  if (!snapshot.data.isToday) snapshot.data.vision = { status: "ok", failing: 0, since: null };
  return snapshot;
}
