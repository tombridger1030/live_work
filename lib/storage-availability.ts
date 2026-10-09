import { stat } from "node:fs/promises";
import path from "node:path";

type DirectoryStat = (pathname: string) => Promise<{ dev: number; isDirectory(): boolean }>;

/**
 * Rejects reads and writes beneath /Volumes when their backing volume is absent.
 * A leftover directory on the boot disk is not a mounted drive. Ordinary local
 * roots retain first-run initialization. No directories or documents are created.
 * Missing mounts and filesystem access failures throw before an empty store can
 * be mistaken for the owner's history. The stat boundary is injectable for tests.
 */
export async function assertStorageMounted(root: string, inspect: DirectoryStat = stat): Promise<void> {
  const resolved = path.resolve(root);
  const prefix = "/Volumes/";
  if (!resolved.startsWith(prefix)) return;
  const volume = path.join("/Volumes", resolved.slice(prefix.length).split("/")[0]);
  let mounted;
  let parent;
  try {
    [mounted, parent] = await Promise.all([inspect(volume), inspect("/Volumes")]);
  } catch {
    throw new Error(`Capture storage unavailable: reconnect ${volume}`);
  }
  if (!mounted.isDirectory() || mounted.dev === parent.dev) {
    throw new Error(`Capture storage unavailable: ${volume} is not mounted`);
  }
}
