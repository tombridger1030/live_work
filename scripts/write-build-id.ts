import { mkdir } from "node:fs/promises";
import path from "node:path";

function gitOutput(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return "unknown";
  return new TextDecoder().decode(result.stdout).trim() || "unknown";
}

const repository = process.cwd();
const commit = gitOutput(["rev-parse", "HEAD"]);
const dirty = gitOutput(["status", "--porcelain"]).length > 0;
const buildId = dirty ? `${commit}-dirty` : commit;
const output = path.join(repository, ".next", "WORK_LIVE_BUILD_ID");
await mkdir(path.dirname(output), { recursive: true });
await Bun.write(output, `${buildId}\n`);
