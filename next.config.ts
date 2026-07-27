import type { NextConfig } from "next";

// The presence detector (lib/presence.ts) loads tfjs + the WASM backend + the
// model from the filesystem at runtime via require.resolve and fs reads. That
// only works if these packages stay EXTERNAL (unbundled, resolvable in
// node_modules) and the model/WASM data files are traced into each serverless
// function that runs detection. Bundling them would break resolve() and strip
// the .wasm/.bin assets.
const TFJS_PACKAGES = [
  "@tensorflow/tfjs-core",
  "@tensorflow/tfjs-converter",
  "@tensorflow/tfjs-backend-wasm",
  "@tensorflow-models/coco-ssd",
];

const DETECTOR_ASSETS = [
  "./models/coco-ssd/**",
  "./node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm",
];

// The deployed Vercel app is no longer the real tally: the dashboard is
// self-hosted on the Mac (docs/decisions/2026-07-23-tally-neon-to-supabase.md).
// Rather than leave the old public URL returning 500 from a dead Neon database,
// proxy every request through to the self-hosted origin so existing links and
// bookmarks keep working.
//
// Gated on VERCEL: locally (and on the self-hosted server itself) this MUST be
// empty, or the server would proxy to itself in an infinite loop.
//
// `beforeFiles` on purpose: an afterFiles rewrite would let Vercel serve its own
// /_next/* assets from ITS build while the HTML comes from the Mac's build, and
// the mismatched asset hashes would 404 the page.
const SELF_HOSTED_ORIGIN =
  process.env.WORK_LIVE_SELF_HOSTED_ORIGIN ?? "https://toms-macbook-pro-1.tail0df074.ts.net";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: TFJS_PACKAGES,
  outputFileTracingIncludes: {
    "/api/browser-capture": DETECTOR_ASSETS,
    "/api/capture": DETECTOR_ASSETS,
    "/api/backfill": DETECTOR_ASSETS,
  },
  async rewrites() {
    if (!process.env.VERCEL) {
      return [];
    }
    return {
      beforeFiles: [{ source: "/:path*", destination: `${SELF_HOSTED_ORIGIN}/:path*` }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
