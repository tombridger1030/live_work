import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const checkedExtensions = new Set([
  ".css",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx"
]);

async function collectFiles(target: string): Promise<string[]> {
  if (!existsSync(target)) {
    throw new Error(`Missing file: ${target}`);
  }

  const stats = statSync(target);
  if (stats.isFile()) {
    return checkedExtensions.has(path.extname(target)) ? [target] : [];
  }

  const ignored = new Set([".next", ".work-live", "node_modules"]);
  const entries = await readdir(target, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => !ignored.has(entry.name))
      .map((entry) => collectFiles(path.join(target, entry.name)))
  );

  return files.flat();
}

function assertNoTrailingWhitespace(filePath: string, source: string): void {
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (/[ \t]$/.test(line)) {
      throw new Error(`${filePath}:${index + 1} has trailing whitespace`);
    }
  }
}

function assertJson(filePath: string, source: string): void {
  try {
    JSON.parse(source);
  } catch (error) {
    throw new Error(`${filePath} is invalid JSON: ${(error as Error).message}`);
  }
}

function assertBalancedCss(filePath: string, source: string): void {
  const opens = source.match(/{/g)?.length ?? 0;
  const closes = source.match(/}/g)?.length ?? 0;
  if (opens !== closes) {
    throw new Error(`${filePath} has unbalanced CSS braces`);
  }
}

function assertTranspiles(filePath: string, source: string): void {
  const extension = path.extname(filePath).slice(1);
  const loader = extension === "tsx" ? "tsx" : extension === "jsx" ? "jsx" : "ts";
  const transpiler = new Bun.Transpiler({ loader });
  transpiler.transformSync(source);
}

async function lintFile(filePath: string): Promise<void> {
  const source = await readFile(filePath, "utf8");
  assertNoTrailingWhitespace(filePath, source);

  const extension = path.extname(filePath);
  if (extension === ".json") {
    assertJson(filePath, source);
  }
  if (extension === ".css") {
    assertBalancedCss(filePath, source);
  }
  if ([".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extension)) {
    assertTranspiles(filePath, source);
  }
}

const targets = process.argv.slice(2).filter((arg) => arg !== "--");
const files = (await Promise.all((targets.length ? targets : ["."]).map(collectFiles))).flat();

await Promise.all(files.map(lintFile));
console.log(`lint:file checked ${files.length} file${files.length === 1 ? "" : "s"}`);
