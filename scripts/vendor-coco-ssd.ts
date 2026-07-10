// Vendors the COCO-SSD (lite_mobilenet_v2) graph model into models/coco-ssd/ so
// the presence detector (lib/presence.ts) loads it OFFLINE inside the Vercel
// serverless bundle — tfhub.dev now redirects to a Kaggle HTML page, so a
// runtime fetch is neither reliable nor allowed. Re-run this only to refresh the
// model. The downloaded files are the standard tfjs-model assets published by
// the TensorFlow team (Apache-2.0).
//
//   bun scripts/vendor-coco-ssd.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-converter";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

const OUT_DIR = path.join(process.cwd(), "models", "coco-ssd");

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  setWasmPaths(path.join(process.cwd(), "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist") + path.sep);
  await tf.setBackend("wasm");
  await tf.ready();

  // Capture every model file tfjs downloads (model.json + weight shards, which
  // are named group<N>-shard<K>of<M> with no extension) and mirror it to disk.
  let bytes = 0;
  const saved: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const res = await origFetch(...args);
    try {
      const url = new URL(typeof args[0] === "string" ? args[0] : (args[0] as Request).url);
      const base = url.pathname.split("/").pop() ?? "";
      if (base === "model.json" || base.includes("shard") || base.endsWith(".bin")) {
        const buf = Buffer.from(await res.clone().arrayBuffer());
        await writeFile(path.join(OUT_DIR, base), buf);
        bytes += buf.byteLength;
        saved.push(base);
      }
    } catch {
      // Non-model fetch (or unreadable body) — ignore; only model files matter.
    }
    return res;
  }) as typeof fetch;

  await cocoSsd.load(); // default base: lite_mobilenet_v2
  globalThis.fetch = origFetch;

  if (!saved.includes("model.json")) {
    throw new Error("Vendoring failed: model.json was not captured");
  }
  console.log(`Vendored ${saved.length} files (${(bytes / 1e6).toFixed(2)} MB) to ${OUT_DIR}`);
  for (const f of saved.sort()) console.log(`  ${f}`);
}

await main();
