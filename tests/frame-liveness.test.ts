import { expect, test } from "bun:test";
import sharp from "sharp";
import { analyzeCaptureLiveness } from "@/lib/frame-liveness";
import type { SnapshotRow } from "@/lib/types";

async function jpeg(r: number, g: number, b: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width: 128, height: 96, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(buffer);
}

function previousAgentSnapshot(frameSignature: string): SnapshotRow {
  return {
    id: "previous",
    capturedAt: "2026-07-08T15:00:00.000Z",
    present: true,
    headphones: true,
    eyesOnScreen: true,
    posture: "upright",
    note: "working",
    score: 100,
    status: "locked_in",
    thumbUrl: "/api/thumb/previous",
    frameHash: "hash",
    captureSource: "agent",
    frameSignature
  };
}

test("agent liveness rejects missing proof frames", async () => {
  const result = await analyzeCaptureLiveness({
    frame: await jpeg(80, 80, 80),
    proofFrame: null,
    source: "agent",
    previous: null
  });

  expect(result.status).toBe("stale");
  expect(result.score).toBe(0);
  expect(result.note).toContain("did not include");
});

test("agent liveness rejects identical decoded proof frames", async () => {
  const frame = await jpeg(80, 80, 80);
  const result = await analyzeCaptureLiveness({ frame, proofFrame: frame, source: "agent", previous: null });

  expect(result.status).toBe("stale");
  expect(result.frameSignature).toBe(result.proofSignature);
  expect(result.note).toContain("identical decoded frames");
});

test("agent liveness rejects a repeated previous decoded frame", async () => {
  const frame = await jpeg(80, 80, 80);
  const first = await analyzeCaptureLiveness({ frame, proofFrame: await jpeg(84, 80, 80), source: "agent", previous: null });
  const second = await analyzeCaptureLiveness({
    frame,
    proofFrame: await jpeg(90, 80, 80),
    source: "agent",
    previous: previousAgentSnapshot(first.frameSignature ?? "")
  });

  expect(first.status).toBe("fresh");
  expect(second.status).toBe("stale");
  expect(second.note).toContain("previous decoded frame");
});

test("browser captures record a signature but are not blocked by missing proof", async () => {
  const result = await analyzeCaptureLiveness({
    frame: await jpeg(80, 80, 80),
    proofFrame: null,
    source: "browser",
    previous: null
  });

  expect(result.status).toBe("not_checked");
  expect(result.frameSignature).toHaveLength(64);
  expect(result.proofSignature).toBeNull();
});
