import { expect, test } from "bun:test";
import { assertStorageMounted } from "@/lib/storage-availability";

const directory = (dev: number) => ({ dev, isDirectory: () => true });

test("missing external storage fails instead of initializing empty history", async () => {
  await expect(assertStorageMounted("/Volumes/Expansion/work-live", async () => {
    throw new Error("ENOENT");
  })).rejects.toThrow("reconnect /Volumes/Expansion");
});

test("a leftover mount directory on the boot disk is rejected", async () => {
  await expect(assertStorageMounted("/Volumes/Expansion/work-live", async () => directory(1)))
    .rejects.toThrow("not mounted");
});

test("mounted external storage becomes available without restarting or cached state", async () => {
  let attached = false;
  const inspect = async (pathname: string) => directory(pathname === "/Volumes" || !attached ? 1 : 2);
  await expect(assertStorageMounted("/Volumes/Expansion/work-live", inspect)).rejects.toThrow("not mounted");
  attached = true;
  await assertStorageMounted("/Volumes/Expansion/work-live", inspect);
});

test("ordinary local storage can initialize without an external volume", async () => {
  await assertStorageMounted("/Users/tombridger/.work-live", async () => {
    throw new Error("local roots must not inspect mount points");
  });
});

test("a file at the expected mount point is rejected", async () => {
  await expect(assertStorageMounted("/Volumes/Expansion/work-live", async (pathname) => ({
    dev: pathname === "/Volumes" ? 1 : 2,
    isDirectory: () => pathname === "/Volumes",
  }))).rejects.toThrow("not mounted");
});
