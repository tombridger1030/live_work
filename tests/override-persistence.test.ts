import { expect, test } from "bun:test";
import { BlobPreconditionFailedError, type GetBlobResult } from "@vercel/blob";
import {
  createLedgerOverrideStore, readLedgerOverrides, saveLedgerDayOverride,
  saveLedgerWeekOverride, type LedgerOverrides,
} from "@/lib/ledger-overrides";
import {
  createDashboardOverrideStore, readDashboardOverrides,
  saveDashboardSignalOverride, saveDashboardCriticalOverride,
} from "@/lib/dashboard-overrides";

type BlobIO = NonNullable<Parameters<typeof createLedgerOverrideStore>[0]>;

// Two independent adapters see the same version before either can save. The
// fake implements atomic storage preconditions, not a process-local write queue.
function sharedBlob(initial: unknown, race = false) {
  let body = initial === null ? null : JSON.stringify(initial);
  let version = body === null ? 0 : 1;
  let reads = 0;
  let writes = 0;
  let conflicts = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const metadata = (pathname: string, etag: string) => ({
    url: `https://store.test/${pathname}`, downloadUrl: `https://store.test/${pathname}`,
    pathname, contentType: "application/json", contentDisposition: "inline", etag,
  });
  const io: BlobIO = {
    async get(pathname, options) {
      expect(options.useCache).toBe(false);
      const capturedBody = body;
      const strongEtag = `"version-${version}"`;
      const etag = new Headers(options.headers).get("accept-encoding") === "identity"
        ? strongEtag : `W/${strongEtag}`;
      reads++;
      if (race && reads <= 2) {
        if (reads === 2) release();
        await barrier;
      }
      if (capturedBody === null) return null;
      return {
        statusCode: 200, stream: new Response(capturedBody).body!, headers: new Headers(),
        blob: { ...metadata(pathname, etag), cacheControl: "", uploadedAt: new Date(0), size: capturedBody.length },
      };
    },
    async put(pathname, next, options) {
      writes++;
      if (body !== null && !options.allowOverwrite) {
        conflicts++;
        throw new Error("This blob already exists");
      }
      if (options.allowOverwrite && options.ifMatch !== `"version-${version}"`) {
        conflicts++;
        throw new BlobPreconditionFailedError();
      }
      expect(typeof next).toBe("string");
      body = String(next);
      version++;
      return metadata(pathname, `"version-${version}"`);
    },
  };
  return { io, value: () => body === null ? null : JSON.parse(body), counts: () => ({ reads, writes, conflicts }) };
}

for (const missing of [false, true]) {
  test(`two ledger instances preserve replies and reachouts (${missing ? "racing creation" : "existing document"})`, async () => {
    const saved: LedgerOverrides = {
      days: { "2026-09-01": { featureDone: true, meetings: 3 } },
      weeks: { "2026-08-31": { reachouts: 100, hours: 40 } },
    };
    const blob = sharedBlob(missing ? null : saved, true);
    const instanceA = createLedgerOverrideStore(blob.io);
    const instanceB = createLedgerOverrideStore(blob.io);
    await Promise.all([
      saveLedgerDayOverride("2026-09-01", { replies: 12 }, instanceA),
      saveLedgerDayOverride("2026-09-01", { reachouts: 1000 }, instanceB),
    ]);
    expect(blob.value()).toEqual({
      days: { "2026-09-01": { ...(missing ? {} : saved.days["2026-09-01"]), replies: 12, reachouts: 1000 } },
      weeks: missing ? {} : saved.weeks,
    });
    expect(blob.counts().conflicts).toBe(1);
    expect(blob.counts().writes).toBe(3);
    expect(await readLedgerOverrides(instanceB)).toEqual(blob.value());
  });

  test(`two dashboard instances preserve signal and critical edits (${missing ? "racing creation" : "existing document"})`, async () => {
    const saved = { snapshots: { old: { present: true, headphones: false } }, critical: { "2026-09-01/8": true } };
    const blob = sharedBlob(missing ? null : saved, true);
    const instanceA = createDashboardOverrideStore(blob.io);
    const instanceB = createDashboardOverrideStore(blob.io);
    await Promise.all([
      saveDashboardSignalOverride("new", { present: false, headphones: true }, instanceA),
      saveDashboardCriticalOverride("2026-09-01", 9, false, instanceB),
    ]);
    expect(blob.value()).toEqual({
      snapshots: { ...(missing ? {} : saved.snapshots), new: { present: false, headphones: true } },
      critical: { ...(missing ? {} : saved.critical), "2026-09-01/9": false },
    });
    expect(blob.counts().conflicts).toBe(1);
    expect(blob.counts().writes).toBe(3);
    expect(await readDashboardOverrides(instanceB)).toEqual(blob.value());
  });
}

test("a weekly goal racing a day edit preserves both across ledger instances", async () => {
  const blob = sharedBlob({ days: {}, weeks: {} }, true);
  await Promise.all([
    saveLedgerDayOverride("2026-09-01", { replies: 8 }, createLedgerOverrideStore(blob.io)),
    saveLedgerWeekOverride("2026-08-31", { reachouts: 200, hours: 50 }, createLedgerOverrideStore(blob.io)),
  ]);
  expect(blob.value()).toEqual({ days: { "2026-09-01": { replies: 8 } }, weeks: { "2026-08-31": { reachouts: 200, hours: 50 } } });
  expect(blob.counts().conflicts).toBe(1);
});

const scenarios = [
  {
    name: "ledger", empty: { days: {}, weeks: {} }, create: createLedgerOverrideStore,
    read: (io: BlobIO) => readLedgerOverrides(createLedgerOverrideStore(io)),
    save: (io: BlobIO) => saveLedgerDayOverride("2026-09-01", { replies: 3 }, createLedgerOverrideStore(io)),
    corrupt: { days: { "2026-09-01": { replies: "lost" } }, weeks: {} },
  },
  {
    name: "dashboard", empty: { snapshots: {}, critical: {} }, create: createDashboardOverrideStore,
    read: (io: BlobIO) => readDashboardOverrides(createDashboardOverrideStore(io)),
    save: (io: BlobIO) => saveDashboardCriticalOverride("2026-09-01", 9, true, createDashboardOverrideStore(io)),
    corrupt: { snapshots: {}, critical: { "2026-09-01/9": "lost" } },
  },
];

for (const scenario of scenarios) {
  test(`${scenario.name} rejects weak or missing ETags before any write`, async () => {
    for (const etag of ['W/"version-1"', ""]) {
      const blob = sharedBlob(scenario.empty);
      const io: BlobIO = {
        ...blob.io,
        async get(pathname, options) {
          expect(new Headers(options.headers).get("accept-encoding")).toBe("identity");
          const result = await blob.io.get(pathname, options);
          if (!result || result.statusCode !== 200) throw new Error("Invalid fixture");
          return { ...result, blob: { ...result.blob, etag } };
        },
      };
      await expect(scenario.read(io)).rejects.toThrow("strong ETag");
      await expect(scenario.save(io)).rejects.toThrow("strong ETag");
      expect(blob.counts().writes).toBe(0);
      expect(blob.value()).toEqual(scenario.empty);
    }
  });

  test(`${scenario.name} read failures propagate and cannot overwrite saved edits`, async () => {
    const blob = sharedBlob(scenario.empty);
    const unavailable = new Error("temporary storage outage");
    const io: BlobIO = { ...blob.io, get: async () => { throw unavailable; } };
    await expect(scenario.read(io)).rejects.toBe(unavailable);
    await expect(scenario.save(io)).rejects.toBe(unavailable);
    expect(blob.counts().writes).toBe(0);
  });

  test(`${scenario.name} malformed saved data throws instead of becoming empty`, async () => {
    for (const invalid of [[], {}, scenario.corrupt]) {
      const blob = sharedBlob(invalid);
      await expect(scenario.read(blob.io)).rejects.toThrow("Invalid");
      await expect(scenario.save(blob.io)).rejects.toThrow("Invalid");
      expect(blob.value()).toEqual(invalid);
      expect(blob.counts().writes).toBe(0);
    }
  });

  test(`${scenario.name} failed JSON stream and unexpected status cannot appear as absent`, async () => {
    const blob = sharedBlob(scenario.empty);
    const result = await blob.io.get("fixture", { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) throw new Error("Invalid fixture");
    const invalidJson: BlobIO = { ...blob.io, get: async () => ({ ...result, stream: new Response("{broken").body! }) };
    await expect(scenario.read(invalidJson)).rejects.toThrow();
    const notModified: GetBlobResult = { ...result, statusCode: 304, stream: null, blob: { ...result.blob, size: null, contentType: null } };
    await expect(scenario.read({ ...blob.io, get: async () => notModified })).rejects.toThrow("read failed");
  });

  test(`${scenario.name} retries only conflicts, with bounded exhaustion`, async () => {
    const blob = sharedBlob(scenario.empty);
    let attempts = 0;
    const io: BlobIO = { ...blob.io, put: async () => { attempts++; throw new BlobPreconditionFailedError(); } };
    await expect(scenario.save(io)).rejects.toThrow("busy");
    expect(attempts).toBe(8);
    expect(blob.value()).toEqual(scenario.empty);
    const failure = new Error("write service unavailable");
    attempts = 0;
    await expect(scenario.save({ ...blob.io, put: async () => { attempts++; throw failure; } })).rejects.toBe(failure);
    expect(attempts).toBe(1);
    // A later request is not poisoned by the previous failure.
    await scenario.save(blob.io);
    expect(blob.value()).not.toEqual(scenario.empty);
  });

  test(`${scenario.name} a genuinely missing blob reads as an empty document`, async () => {
    expect(await scenario.read(sharedBlob(null).io)).toEqual(scenario.empty);
  });
}

test("absent Blob configuration keeps local read-only consumers usable", async () => {
  expect(process.env.BLOB_READ_WRITE_TOKEN).toBeUndefined();
  expect(await readLedgerOverrides()).toEqual({ days: {}, weeks: {} });
  expect(await readDashboardOverrides()).toEqual({ snapshots: {}, critical: {} });
});
