import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { buildHourlyCheckin } from "@/lib/rollup";
import { dayStats } from "@/lib/dashboard";
import { scoreFrom } from "@/lib/score";
import type { DashboardData } from "@/lib/dashboard";
import type { Signals, SnapshotRow } from "@/lib/types";

const DASHBOARD_OVERRIDES_PATHNAME = "mirror/dashboard-overrides.json";

export type DashboardSignalOverride = Pick<Signals, "present" | "headphones">;

export type DashboardOverrides = {
  snapshots: Record<string, DashboardSignalOverride>;
  critical: Record<string, boolean>;
};

const emptyOverrides = (): DashboardOverrides => ({
  snapshots: {},
  critical: {},
});

function parseOverrides(value: unknown): DashboardOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid dashboard overlay");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of ["snapshots","critical"]) {
    if (!candidate[field] || typeof candidate[field] !== "object" || Array.isArray(candidate[field])) {
      throw new Error("Invalid dashboard overlay");
    }
  }
  const snapshots: DashboardOverrides["snapshots"] = {};
  if (
    candidate.snapshots &&
    typeof candidate.snapshots === "object" &&
    !Array.isArray(candidate.snapshots)
  ) {
    for (const [id, override] of Object.entries(candidate.snapshots)) {
      if (
        override &&
        typeof override === "object" &&
        !Array.isArray(override) &&
        Object.keys(override).every((field) =>
          ["present", "headphones"].includes(field),
        ) &&
        Object.values(override).every((field) => typeof field === "boolean")
      ) {
        snapshots[id] = override as DashboardSignalOverride;
      } else {
        throw new Error("Invalid dashboard signal override");
      }
    }
  }
  const critical: DashboardOverrides["critical"] = {};
  if (
    candidate.critical &&
    typeof candidate.critical === "object" &&
    !Array.isArray(candidate.critical)
  ) {
    for (const [key, valueForKey] of Object.entries(candidate.critical)) {
      if (typeof valueForKey === "boolean") {
        critical[key] = valueForKey;
      } else {
        throw new Error("Invalid dashboard critical override");
      }
    }
  }
  return { snapshots, critical };
}

/**
 * Atomic document boundary. Reads bypass caches and return independent values;
 * null ETag means the document is absent. Writes are create-only for null, or
 * compare-and-swap otherwise. Only conflicts return false; service failures throw.
 */
export type DashboardOverrideStore = {
  read(): Promise<{ overrides: DashboardOverrides; etag: string | null }>;
  write(overrides: DashboardOverrides, etag: string | null): Promise<boolean>;
};

/** Uses the existing private document without changing its JSON shape.
 * Injectable Blob operations let isolated serverless instances share one store.
 */
export function createDashboardOverrideStore(blob = { get, put }): DashboardOverrideStore {
  return {
    async read() {
      // Compression weakens ETags; CAS needs the strong token from this same read.
      const result = await blob.get(DASHBOARD_OVERRIDES_PATHNAME, {
        access: "private",
        useCache: false,
        headers: { "accept-encoding": "identity" },
      });
      if (!result) return { overrides: emptyOverrides(), etag: null };
      if (result.statusCode !== 200) throw new Error("Dashboard overlay read failed");
      if (!result.blob.etag || result.blob.etag.startsWith("W/")) {
        throw new Error("Dashboard overlay requires a strong ETag");
      }
      return {
        overrides: parseOverrides(await new Response(result.stream).json()),
        etag: result.blob.etag,
      };
    },
    async write(overrides, etag) {
      try {
        await blob.put(DASHBOARD_OVERRIDES_PATHNAME, JSON.stringify(overrides), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: etag !== null,
          ...(etag === null ? {} : { ifMatch: etag }),
          contentType: "application/json",
          cacheControlMaxAge: 60,
        });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false;
        if (etag === null && error instanceof Error && /already exists/i.test(error.message)) return false;
        throw error;
      }
    },
  };
}

async function updateOverrides(
  store: DashboardOverrideStore,
  update: (current: DashboardOverrides) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { overrides, etag } = await store.read();
    update(overrides);
    if (await store.write(overrides, etag)) return;
  }
  throw new Error("Dashboard overlay is busy; retry the edit");
}

function criticalKey(day: string, hour: number): string {
  return `${day}/${hour}`;
}

/**
 * Reads saved owner edits. Only absent configuration or a missing document yields
 * an empty overlay. Configured storage/parse failures throw so callers preserve
 * their last successful display rather than show the saved edits as missing.
 * An injected store is always read, including in tests without Blob credentials.
 */
export async function readDashboardOverrides(store?: DashboardOverrideStore): Promise<DashboardOverrides> {
  if (!store && !process.env.BLOB_READ_WRITE_TOKEN) return emptyOverrides();
  return (await (store ?? createDashboardOverrideStore()).read()).overrides;
}

/**
 * Persists one owner correction for a captured snapshot on the deployment.
 *
 * Preconditions: `snapshotId` identifies a snapshot in the published mirror
 * and `fields` contains only the two human-correctable boolean signals.
 * Postcondition: later mirror reads re-score that snapshot with the correction.
 */
export function saveDashboardSignalOverride(
  snapshotId: string,
  fields: DashboardSignalOverride,
  store = createDashboardOverrideStore(),
): Promise<void> {
  return updateOverrides(store, (current) => {
    current.snapshots[snapshotId] = {
      ...current.snapshots[snapshotId],
      ...fields,
    };
  });
}

/**
 * Persists one owner critical-hour flag on the deployment.
 *
 * Preconditions: `day` and `hour` identify an hourly check-in in the published
 * mirror. Postcondition: later mirror reads show the submitted human flag and
 * update the visible critical-hour total.
 */
export function saveDashboardCriticalOverride(
  day: string,
  hour: number,
  critical: boolean,
  store = createDashboardOverrideStore(),
): Promise<void> {
  return updateOverrides(store, (current) => {
    current.critical[criticalKey(day, hour)] = critical;
  });
}

function correctedSnapshot(
  snapshot: SnapshotRow,
  overrides: DashboardOverrides["snapshots"],
): SnapshotRow {
  const fields = overrides[snapshot.id];
  if (!fields) {
    return snapshot;
  }
  const signals: Signals = { ...snapshot, ...fields };
  const score = scoreFrom(signals);
  return { ...snapshot, ...fields, score: score.score, status: score.status };
}

/**
 * Applies dashboard corrections to the newest mirror snapshot and rebuilds its
 * visible hourly and day-level values.
 *
 * Preconditions: `data` is the assembled mirror dashboard and `overrides` has
 * passed the private blob parser. Postconditions: all visible corrected frames,
 * hourly rollups, the selected-day stats, and critical-hour counts agree; input
 * data is never mutated. Capture-owned timestamps and frame assets are retained.
 */
export function applyDashboardOverrides(
  data: DashboardData,
  overrides: DashboardOverrides,
): DashboardData {
  if (
    Object.keys(overrides.snapshots).length === 0 &&
    Object.keys(overrides.critical).length === 0
  ) {
    return data;
  }

  const hourlyFrames = Object.fromEntries(
    Object.entries(data.hourlyFrames).map(([hour, frames]) => [
      Number(hour),
      frames.map((snapshot) =>
        correctedSnapshot(snapshot, overrides.snapshots),
      ),
    ]),
  );
  const latest = data.latest
    ? correctedSnapshot(data.latest, overrides.snapshots)
    : null;
  const hourly = data.hourly.map((checkin) => {
    const frames = hourlyFrames[checkin.hour] ?? [];
    const rebuilt =
      frames.length > 0
        ? buildHourlyCheckin(checkin.day, checkin.hour, frames)
        : checkin;
    const overrideKey = criticalKey(checkin.day, checkin.hour);
    return {
      ...rebuilt,
      critical: overrides.critical[overrideKey] ?? checkin.critical,
    };
  });
  const viewSnapshots = Object.values(hourlyFrames).flat();

  return {
    ...data,
    latest,
    hourlyFrames,
    hourly,
    stats: dayStats(viewSnapshots, hourly),
  };
}
