"use client";

import { useEffect, useState } from "react";
import type { CaptureFreshness, CaptureHealth } from "@/lib/types";
import { captureAlertAfterMinutes } from "@/lib/capture-thresholds";

export type MirrorView = {
  /** Last successful publication, not evidence of the Mac's capture state. */
  publishedAt: string;
  captureHealth: CaptureHealth;
  captureFreshness: CaptureFreshness;
  /** Retained for older callers; browsers no longer leave the deployed site. */
  liveUrl?: string;
};

/** Displays image freshness separately from the publication timestamp. */
export function MirrorNotice({ publishedAt, captureHealth, captureFreshness }: MirrorView) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = now === null ? null : Math.max(0, Math.floor((now - Date.parse(publishedAt)) / 60_000));
  const age = minutes === null ? "" : minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`;
  const clock = now ?? Date.parse(publishedAt);
  const imageAge = captureHealth.lastImageAt
    ? Math.max(0, Math.floor((clock - Date.parse(captureHealth.lastImageAt)) / 60_000))
    : null;
  const imageAgeText = imageAge === null
    ? "never"
    : imageAge < 1 ? "just now" : imageAge < 60 ? `${imageAge} min ago` : imageAge < 1440 ? `${Math.floor(imageAge / 60)} hr ago` : `${Math.floor(imageAge / 1440)} days ago`;
  const attemptAge = captureHealth.lastAttemptAt
    ? Math.max(0, Math.floor((clock - Date.parse(captureHealth.lastAttemptAt)) / 60_000))
    : null;
  const stale = captureFreshness.expected && (
    attemptAge === null || attemptAge > captureAlertAfterMinutes || imageAge === null || imageAge > captureAlertAfterMinutes
  );
  const failureText = captureHealth.lastFailure === "camera_unavailable"
    ? "Camera unavailable"
    : captureHealth.lastFailure === "provider_failed"
      ? "Vision provider unavailable"
      : captureHealth.lastFailure === "storage_failed"
        ? "Capture storage unavailable"
        : null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" role="status">
      <span>{stale ? "Capture data is stale" : "Capture data synced"}</span>
      <span>· Last image <time dateTime={captureHealth.lastImageAt ?? undefined} className="tabular-nums">{imageAgeText}</time></span>
      {failureText ? <span>· {failureText}</span> : null}
      <span>· Copy updated <time dateTime={publishedAt} className="tabular-nums">{age || new Date(publishedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"}</time></span>
      {stale ? <span>· Your edits still save here.</span> : null}
    </div>
  );
}
