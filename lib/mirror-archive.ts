import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import { isValidDayKey, localDayKey } from "@/lib/time";

export const ARCHIVE_PREFIX = "mirror/archive/";
const DAY_PREFIX = `${ARCHIVE_PREFIX}days/`;
export const ARCHIVE_DAYS = 30;
// Successful immutable lookups avoid one network request per old frame on every
// capture. Bounded, short-lived metadata only; never holds image bytes or misses.
const knownAssets = new Map<string, number>();

/** Calendar retention includes today and the preceding 29 local dates, across DST. */
export function archiveIncludes(day: string, now = new Date()): boolean {
  if (!isValidDayKey(day)) return false;
  const today = localDayKey(now);
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - ARCHIVE_DAYS + 1);
  return day >= cutoff.toISOString().slice(0, 10) && day <= today;
}

/** Only calendar days and opaque snapshot identifiers may address this namespace. */
export function archivePath(day: string, id?: string): string {
  if (!isValidDayKey(day) || (id !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
    throw new Error("Invalid archive address");
  }
  return id === undefined ? `${DAY_PREFIX}${day}.json` : `${ARCHIVE_PREFIX}${day}/frames/${id}.jpg`;
}

export const archiveIO = {
  async read(path: string): Promise<Response | null> {
    const result = await get(path, { access: "private", useCache: false });
    return result?.statusCode === 200 ? new Response(result.stream) : null;
  },
  async exists(path: string): Promise<boolean> {
    if ((knownAssets.get(path) ?? 0) > Date.now()) return true;
    try {
      await head(path);
      rememberAsset(path);
      return true;
    } catch (error) {
      if (error instanceof BlobNotFoundError) return false;
      throw error;
    }
  },
  async write(path: string, body: string | Buffer, contentType: string, overwrite: boolean): Promise<void> {
    await put(path, body, { access: "private", addRandomSuffix: false, allowOverwrite: overwrite, contentType });
    if (!overwrite) rememberAsset(path);
  },
  async paths(prefix = ARCHIVE_PREFIX): Promise<string[]> {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor });
      paths.push(...page.blobs.map((blob) => blob.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return paths;
  },
  async remove(path: string): Promise<void> { await del(path); knownAssets.delete(path); },
};

function rememberAsset(path: string): void {
  knownAssets.set(path, Date.now() + 15 * 60_000);
  if (knownAssets.size > 1024) knownAssets.delete(knownAssets.keys().next().value!);
}

/** Returns retained published dates newest-first, independently of today's availability. Throws on storage failure. */
export async function listArchivedDays(now = new Date(), io = archiveIO): Promise<string[]> {
  const days = (await io.paths(DAY_PREFIX)).flatMap((path) => {
    if (!path.startsWith(DAY_PREFIX)) return [];
    const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(path.slice(DAY_PREFIX.length));
    return match && archiveIncludes(match[1], now) ? [match[1]] : [];
  });
  return [...new Set(days)].sort().reverse();
}

/** Public dashboard image read: accepts only retained archive addresses, never arbitrary Blob paths. */
export async function readArchiveAsset(day: string, id: string, now = new Date(), io = archiveIO): Promise<Response> {
  let path: string;
  try { path = archivePath(day, id); } catch { return new Response(null, { status: 404 }); }
  if (!archiveIncludes(day, now)) return new Response(null, { status: 404 });
  try {
    const result = await io.read(path);
    if (!result) return new Response(null, { status: 404 });
    return new Response(result.body, { headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch { return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}

/**
 * Stores one immutable compact JPEG per snapshot, reusing existing bytes across
 * publishes/restarts. Missing source bytes yield an empty URL; storage failures
 * throw so no day document is published with a falsely successful image upload.
 * Source bytes are read only when the asset is absent. Never alters local files.
 */
export async function archiveFrame(
  day: string,
  id: string,
  source: () => Promise<Uint8Array | null>,
  io = archiveIO,
): Promise<string> {
  const path = archivePath(day, id);
  if (!await io.exists(path)) {
    const bytes = await source();
    if (!bytes) return "";
    const sharp = (await import("sharp")).default;
    let jpeg: Buffer;
    try {
      jpeg = await sharp(Buffer.from(bytes), { failOn: "warning" }).rotate()
        .resize({ width: 512, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 60, mozjpeg: true }).toBuffer();
    } catch { return ""; }
    try {
      await io.write(path, jpeg, "image/jpeg", false);
    } catch (error) {
      // Another publisher may have won the immutable create race.
      if (!await io.exists(path)) throw error;
    }
  }
  return `/mirror-assets/${day}/${id}`;
}

/**
 * Lists expired archive objects; deletes only when dryRun is explicitly false.
 * Unknown paths, future dates, overlays, the legacy mirror and local captures
 * are never deletion candidates. Call from maintenance, never the read path.
 */
export async function cleanupArchive({ dryRun = true, now = new Date() } = {}, io = archiveIO): Promise<string[]> {
  const expired = (await io.paths()).filter((path) => {
    if (!path.startsWith(ARCHIVE_PREFIX)) return false;
    const relative = path.slice(ARCHIVE_PREFIX.length);
    const match = /^days\/(\d{4}-\d{2}-\d{2})\.json$/.exec(relative)
      ?? /^(\d{4}-\d{2}-\d{2})\/frames\/[a-zA-Z0-9_-]{1,128}\.jpg$/.exec(relative);
    return !!match && isValidDayKey(match[1]) && match[1] < localDayKey(now) && !archiveIncludes(match[1], now);
  });
  if (!dryRun) for (const path of expired) await io.remove(path);
  return expired;
}
