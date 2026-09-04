"use client";

import { useEffect, useState } from "react";

export type MirrorView = {
  /** Last successful publication, not evidence of the Mac's power state. */
  publishedAt: string;
  /** Retained for older callers; browsers no longer leave the deployed site. */
  liveUrl?: string;
};

/** Displays observed publication freshness without inferring machine health. */
export function MirrorNotice({ publishedAt }: MirrorView) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = now === null ? null : Math.max(0, Math.floor((now - Date.parse(publishedAt)) / 60_000));
  const age = minutes === null ? "" : minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" role="status">
      <span>Capture data synced</span>
      <time dateTime={publishedAt} className="tabular-nums">{age || new Date(publishedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"}</time>
      {minutes !== null && minutes > 40 ? <span>· No newer capture data received. Your edits still save here.</span> : null}
    </div>
  );
}
