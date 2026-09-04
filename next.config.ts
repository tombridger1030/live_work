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

// Browser reads and owner edits stay on Vercel. Capture-only endpoints are
// explicitly unavailable there; the Mac agent addresses its loopback server.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: TFJS_PACKAGES,
  outputFileTracingIncludes: {
    "/api/browser-capture": DETECTOR_ASSETS,
    "/api/capture": DETECTOR_ASSETS,
    "/api/backfill": DETECTOR_ASSETS,
  },
};

export default nextConfig;
