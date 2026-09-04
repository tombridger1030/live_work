"use client";

import { useEffect, useState } from "react";
import type { CodePulseData } from "@/lib/code-velocity";

/** Relative elapsed age for a verified ISO timestamp; `now` is epoch milliseconds. */
export function codePulseAge(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** Passive, same-origin view. `selectedDay` is an optional YYYY-MM-DD local day
 * for raw counts; pace always describes the latest verified rolling seven days.
 * Refreshes on mount, every minute, and on return/online. Failed reads preserve
 * values only for the same selected day. No credentials reach this component.
 */
export function CodePulse({ day, selectedDay = day }: { day?: string; selectedDay?: string }) {
  const [saved, setSaved] = useState<{ key: string; data: CodePulseData } | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const key = selectedDay ?? "";
  const data = saved?.key === key ? saved.data : null;

  useEffect(() => {
    const controller = new AbortController();
    let active = false;
    setFailed(false);
    const refresh = async () => {
      if (active || document.visibilityState === "hidden") return;
      setNow(Date.now());
      active = true;
      try {
        const query = selectedDay ? `?day=${encodeURIComponent(selectedDay)}` : "";
        const response = await fetch(`/mirror-api/github${query}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error("Unavailable");
        const value: CodePulseData = await response.json();
        if (!["ready", "building-baseline", "unavailable"].includes(value.status)) throw new Error("Invalid response");
        if (!controller.signal.aborted) {
          setSaved({ key: selectedDay ?? "", data: value });
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally { active = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onReturn = () => void refresh();
    window.addEventListener("focus", onReturn);
    window.addEventListener("online", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("online", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [selectedDay]);

  const stale = failed || data?.freshness === "stale";
  const commits = data?.day?.commits;
  const merges = data?.day?.merges;
  const status = stale ? "Update delayed" : data?.asOf ? "Synced from GitHub" : failed || data?.status === "unavailable" ? "Awaiting GitHub sync" : "Checking GitHub…";
  return (
    <section aria-label="Code Pulse" className="rounded-2xl bg-card p-4 text-card-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-balance text-base font-semibold tracking-tight">Code Pulse</h2>
        <p role="status" className={`text-xs ${stale ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>{status}</p>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-4 tabular-nums">
        <div><dd className="text-2xl font-semibold tracking-tight">{commits ?? "—"}</dd><dt className="text-xs text-muted-foreground">Commits</dt></div>
        <div><dd className="text-2xl font-semibold tracking-tight">{merges ?? "—"}</dd><dt className="text-xs text-muted-foreground">Merged PRs</dt></div>
        <div title="Latest 7 elapsed days of commits + merged PRs, divided by the prior 28-day weekly average, capped at 100.">
          <dd className="text-2xl font-semibold tracking-tight">{data?.score ?? "—"}<span className="ml-1 text-xs font-normal text-muted-foreground">/ 100</span></dd>
          <dt className="text-xs text-muted-foreground">{data?.status === "building-baseline" ? "Building baseline" : "7-day pace"}</dt>
        </div>
      </dl>
      <p className="mt-2 text-pretty text-xs text-muted-foreground">Default branch · {selectedDay ?? "today"} · authored activity</p>
      <p className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Last commit {data?.lastCommitAt ? <time className="font-medium text-card-foreground" dateTime={data.lastCommitAt} title={new Date(data.lastCommitAt).toLocaleString()}>{codePulseAge(data.lastCommitAt, now)}</time> : data?.asOf ? "none found" : "not yet verified"}</span>
        {data?.asOf && <span>Verified <time dateTime={data.asOf} title={new Date(data.asOf).toLocaleString()}>{codePulseAge(data.asOf, now)}</time>{stale ? " · saved" : ""}</span>}
      </p>
    </section>
  );
}
