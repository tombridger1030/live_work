"use client";

import { useRouter } from "next/navigation";
import { Button, Card } from "@heroui/react";
import { GeistMono } from "geist/font/mono";
import { Check, Eye, EyeOff, Headphones, HeadphoneOff, Loader2, Star, Tally5, User, UserX, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart } from "@/components/charts/BarChart";
import { DayHeatmap } from "@/components/DayHeatmap";
import type { DashboardData } from "@/lib/dashboard";
import { nextPosture } from "@/lib/feedback";
import { isQuietHour } from "@/lib/time";
import { shouldReloadForLatestSnapshot } from "@/lib/return-refresh";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { statusLabels } from "@/lib/status";
import type { AverageWindow, Posture, SnapshotRow, TodayStats } from "@/lib/types";
import { trend, type Delta } from "@/lib/delta";
import { cn } from "@/lib/utils";

type Tab = "today" | "average";

type MetricCard = { label: string; value: string } & Delta;

type Armed = { field: "present" | "headphones" | "eyesOnScreen" | "posture"; value: boolean | Posture };

type EditableSignal = {
  field: "present" | "headphones" | "eyesOnScreen";
  on: boolean;
  onLabel: string;
  offLabel: string;
  onIcon: LucideIcon;
  offIcon: LucideIcon;
};

function hourClock(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12} ${period}`;
}

function hourTick(hour: number): string {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}${hour < 12 ? "a" : "p"}`;
}

function frameTime(capturedAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(capturedAt));
}

function pctText(value: number): string {
  return `${Math.round(value)}%`;
}

function editableSignalsFor(snapshot: SnapshotRow): EditableSignal[] {
  return [
    { field: "present", on: snapshot.present, onLabel: "Present", offLabel: "Away", onIcon: User, offIcon: UserX },
    { field: "eyesOnScreen", on: snapshot.eyesOnScreen, onLabel: "Facing screen", offLabel: "Looking away", onIcon: Eye, offIcon: EyeOff },
    { field: "headphones", on: snapshot.headphones, onLabel: "Headphones", offLabel: "No headphones", onIcon: Headphones, offIcon: HeadphoneOff }
  ];
}

function todayMetrics(today: TodayStats, previous: TodayStats | null, deltaNote: string): MetricCard[] {
  return [
    { label: "Hours present", value: today.hoursPresent.toFixed(1), ...trend(today.hoursPresent, previous?.hoursPresent ?? null, 1, deltaNote) },
    { label: "Avg focus", value: pctText(today.avgScore), ...trend(today.avgScore, previous?.avgScore ?? null, 0, deltaNote, "%") },
    { label: "Headphones", value: pctText(today.headphonesPct), ...trend(today.headphonesPct, previous?.headphonesPct ?? null, 0, deltaNote, "%") },
    { label: "Critical hours", value: `${today.criticalHours}h`, ...trend(today.criticalHours, previous?.criticalHours ?? null, 0, deltaNote) }
  ];
}

function averageMetrics(last7: AverageWindow): MetricCard[] {
  return [
    { label: "Hours present", value: last7.hoursPresent.toFixed(1), delta: null, deltaNote: "Last 7 days", deltaSign: "none" },
    { label: "Avg focus", value: pctText(last7.avgScore), delta: null, deltaNote: "Last 7 days", deltaSign: "none" },
    { label: "Headphones", value: pctText(last7.headphonesPct), delta: null, deltaNote: "Last 7 days", deltaSign: "none" },
    { label: "Critical hours", value: `${last7.criticalHours.toFixed(1)}h`, delta: null, deltaNote: "Last 7 days", deltaSign: "none" }
  ];
}

function Num({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("tabular-nums", className)} style={GeistMono.style}>
      {children}
    </span>
  );
}

function criticalLabel(armed: boolean, critical: boolean): string {
  if (armed) {
    return critical ? "Remove critical hour" : "Confirm critical hour";
  }
  return critical ? "Critical hour" : "Mark critical hour";
}

// Trailing affordance shown only once a tag is armed: a spinner while the write
// is in flight, otherwise a confirm check. Shared by every two-tap toggle.
function ConfirmAffordance({ armed, pending }: { armed: boolean; pending: boolean }) {
  if (!armed) {
    return null;
  }
  return pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Check className="size-3" aria-hidden />;
}

export function Dashboard({ data }: { data: DashboardData }) {
  const router = useRouter();
  useRefreshOnReturn();
  const [tab, setTab] = useState<Tab>("today");
  const [selectedHour, setSelectedHour] = useState<number | null>(data.defaultHour);
  const [frameIndex, setFrameIndex] = useState(-1);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [pending, setPending] = useState(false);
  const [criticalArmed, setCriticalArmed] = useState(false);
  const [criticalPending, setCriticalPending] = useState(false);
  const tagsRef = useRef<HTMLDivElement | null>(null);
  const selectedFrameButtonRef = useRef<HTMLButtonElement | null>(null);

  const liveSnapshotId = data.isToday ? data.latest?.id : null;

  useEffect(() => {
    setFrameIndex(-1);
  }, [selectedHour]);

  useEffect(() => {
    setSelectedHour(data.defaultHour);
    setFrameIndex(-1);
    setArmed(null);
    setCriticalArmed(false);
  }, [data.viewDay, data.defaultHour, liveSnapshotId]);

  useEffect(() => {
    setArmed(null);
    setCriticalArmed(false);
  }, [selectedHour]);

  useEffect(() => {
    if (!armed) {
      return;
    }
    function onDown(event: MouseEvent) {
      if (tagsRef.current && !tagsRef.current.contains(event.target as Node)) {
        setArmed(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [armed]);

  // Poll for new snapshots when viewing today, and check immediately when the
  // user returns to the tab/window. If the server has a newer snapshot id than
  // the one rendered, force a real reload; soft router.refresh() has proven too
  // weak for this live dashboard path.
  useEffect(() => {
    if (!data.isToday || data.settings.paused) return;

    let checking = false;
    let reloading = false;
    const renderedLatestId = data.latest?.id ?? null;

    async function refreshFromStatus(): Promise<void> {
      if (checking || reloading) return;
      checking = true;
      try {
        const res = await fetch(`/api/status?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { latestId: string | null };
        if (shouldReloadForLatestSnapshot(renderedLatestId, body.latestId)) {
          reloading = true;
          window.location.reload();
          return;
        }
        // Already showing the server's latest snapshot. Do nothing; polling is
        // only here to detect a newer snapshot, not to churn the RSC tree.
      } catch {
        // Network error — skip this check, the next focus/poll will retry.
      } finally {
        checking = false;
      }
    }

    const onFocus = () => void refreshFromStatus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshFromStatus();
    };
    const onPageShow = () => void refreshFromStatus();

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    const interval = setInterval(() => void refreshFromStatus(), 5_000);
    void refreshFromStatus();

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      clearInterval(interval);
    };
  }, [data.isToday, data.settings.paused, data.latest?.id, router]);

  const activeHour = selectedHour ?? data.defaultHour;
  const activeFrames = activeHour === null ? [] : data.hourlyFrames[activeHour] ?? [];
  const followingLatest = data.isToday && frameIndex < 0 && activeHour === data.defaultHour;
  const selected =
    followingLatest && data.latest
      ? data.latest
      : frameIndex >= 0
        ? activeFrames[frameIndex]
        : (activeFrames.at(-1) ?? null);
  const selectedFrameId = selected?.id ?? null;

  useEffect(() => {
    const button = selectedFrameButtonRef.current;
    if (!button) {
      return;
    }
    button.scrollIntoView({ block: "nearest", inline: "end", behavior: "auto" });
  }, [selectedFrameId]);
  const activeCheckin = activeHour === null ? null : data.hourly.find((checkin) => checkin.hour === activeHour) ?? null;

  const chartData = useMemo(() => {
    const byHour = new Map(data.hourly.map((checkin) => [checkin.hour, checkin]));
    const rows: Array<{ hour: number; label: string; score: number; critical: boolean }> = [];
    for (let hour = 0; hour < 24; hour += 1) {
      if (isQuietHour(hour)) continue;
      const checkin = byHour.get(hour);
      rows.push({ hour, label: hourTick(hour), score: checkin?.avgScore ?? 0, critical: checkin?.critical ?? false });
    }
    return rows;
  }, [data.hourly]);

  const liveFrameId = data.isToday && !data.settings.paused && !data.statusState.stale && data.latest ? data.latest.id : null;
  const isLive = selected !== null && liveFrameId !== null && selected.id === liveFrameId;
  const detailAvg =
    activeCheckin?.avgScore ??
    (activeFrames.length > 0 ? Math.round(activeFrames.reduce((total, frame) => total + frame.score, 0) / activeFrames.length) : 0);
  const detailPresentPct =
    activeCheckin?.presentPct ?? (activeFrames.length > 0 ? Math.round((activeFrames.filter((frame) => frame.present).length / activeFrames.length) * 100) : 0);
  const detailHeadphonesPct =
    activeCheckin?.headphonesPct ??
    (activeFrames.length > 0 ? Math.round((activeFrames.filter((frame) => frame.headphones).length / activeFrames.length) * 100) : 0);

  const metrics = tab === "today" ? todayMetrics(data.stats, data.previousStats, data.isToday ? "vs yesterday at this time" : "vs yesterday") : averageMetrics(data.averages.last7);
  const selectedSignals = selected ? editableSignalsFor(selected) : [];
  const heroStatus = selected ? statusLabels[selected.status] : data.statusState.headline;
  const shownPosture = selected ? (armed?.field === "posture" ? String(armed.value) : selected.posture) : null;

  async function confirmCorrection(field: Armed["field"], value: boolean | Posture) {
    if (!selected || pending) {
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: selected.id, field, value })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      setArmed(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function confirmCriticalHour() {
    if (activeHour === null || !activeCheckin || criticalPending) {
      return;
    }
    setCriticalPending(true);
    try {
      const response = await fetch("/api/critical", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ day: data.viewDay, hour: activeHour, critical: !activeCheckin.critical })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      setCriticalArmed(false);
      router.refresh();
    } finally {
      setCriticalPending(false);
    }
  }

  async function tapCriticalHour() {
    if (!activeCheckin || criticalPending) {
      return;
    }
    if (criticalArmed) {
      await confirmCriticalHour();
      return;
    }
    setCriticalArmed(true);
  }

  async function tapBooleanSignal(signal: EditableSignal) {
    const proposed = !signal.on;
    if (armed?.field === signal.field) {
      await confirmCorrection(signal.field, armed.value as boolean);
      return;
    }
    setArmed({ field: signal.field, value: proposed });
  }

  async function tapPosture() {
    if (!selected) {
      return;
    }
    if (armed?.field === "posture") {
      await confirmCorrection("posture", armed.value as Posture);
      return;
    }
    setArmed({ field: "posture", value: nextPosture(selected.posture) });
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Tally5 className="size-4 shrink-0 text-foreground" strokeWidth={2.5} aria-hidden />
          <span className="text-sm font-semibold tracking-tight">tally</span>
          <span className="truncate text-sm text-zinc-500">{data.isToday ? `Today · ${data.viewDayLabel}` : data.viewDayLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
          {!data.isToday ? (
            <button
              type="button"
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.delete("day");
                router.replace(url.pathname + url.search);
                router.refresh();
              }}
              className="text-xs text-zinc-300 hover:text-zinc-100 transition"
            >
              Back to today
            </button>
          ) : null}
          <span className="size-1.5 rounded-full bg-zinc-400" aria-hidden />
          {data.statusState.lastCheckedText}
        </div>
      </header>
      <div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)] lg:items-start">
            <div>
            <div className="relative overflow-hidden">
              <div className="aspect-[4/3] max-h-[520px] w-full">
                {selected?.thumbUrl ? (
                  <img
                    alt={`Snapshot at ${frameTime(selected.capturedAt, data.timeZone)}`}
                    className={cn("h-full w-full object-cover", data.settings.blur && "blur-md")}
                    src={selected.thumbUrl}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-zinc-500">No frame</div>
                )}
              </div>
              {isLive ? (
                <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-md bg-black/40 px-2 py-1 text-[10px] font-medium tracking-wide text-zinc-200 backdrop-blur">
                  <span className="size-1.5 rounded-full bg-zinc-100" aria-hidden /> LIVE
                </span>
              ) : null}
            </div>
              {activeFrames.length > 0 ? (
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="listbox" aria-label={`${activeHour ?? 0} snapshots`}>
                  {activeFrames.map((frame, position) => {
                    const isSelectedFrame = position === frameIndex || (frameIndex < 0 && position === activeFrames.length - 1);

                    return (
                      <button
                        key={frame.id}
                        ref={isSelectedFrame ? selectedFrameButtonRef : null}
                        type="button"
                        role="option"
                        aria-selected={isSelectedFrame}
                        aria-label={`Snapshot at ${frameTime(frame.capturedAt, data.timeZone)}, focus ${frame.score}`}
                        onClick={() => setFrameIndex(position)}
                        className={cn(
                          "relative shrink-0 overflow-hidden rounded-md border transition",
                          isSelectedFrame ? "border-zinc-100" : "border-white/10 hover:border-white/20"
                        )}
                      >
                        <img alt="" className={cn("h-14 w-20 object-cover", data.settings.blur && "blur-md")} src={frame.thumbUrl} />
                        <span className="absolute inset-x-0 bottom-0 h-1.5 bg-zinc-300" aria-hidden />
                        <span className="absolute top-1 right-1 rounded bg-black/70 px-1 text-[10px] text-zinc-100">
                          <Num>{String(frame.score)}</Num>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-100">{activeHour === null ? data.viewDayLabel : hourClock(activeHour)}</span>
                <span className="text-[11px] font-medium tracking-wide text-zinc-200 uppercase">
                  {heroStatus}
                </span>
              </div>
              <div className="flex items-end gap-6 sm:gap-8">
                <div className="min-w-0">
                  <p className="mb-2 text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
                    {isLive ? "Right now" : "This snapshot"}
                  </p>
                  <div className="flex items-end gap-1.5">
                    <Num className="text-6xl leading-none font-semibold tracking-[-0.05em] text-zinc-50">{String(selected?.score ?? 0)}</Num>
                    <span className="pb-1 text-lg text-zinc-500">/100</span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-500">{selected ? frameTime(selected.capturedAt, data.timeZone) : data.statusState.lastCheckedText}</p>
                </div>
                <div className="h-10 w-px bg-white/8" />
                <div>
                  <p className="mb-2 text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">This hour</p>
                  <div className="flex items-end gap-1.5">
                    <Num className="text-3xl leading-none font-semibold tracking-[-0.04em] text-zinc-200">{String(detailAvg)}</Num>
                    <span className="pb-0.5 text-sm text-zinc-500">avg</span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-500">
                    <Num>{String(detailPresentPct)}</Num>% present · <Num>{String(detailHeadphonesPct)}</Num>% headphones
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs text-zinc-500">
                <Num>{String(activeFrames.length)}</Num> {activeFrames.length === 1 ? "snapshot" : "snapshots"} this hour
              </p>

              {activeCheckin ? (
                <button
                  type="button"
                  disabled={criticalPending}
                  aria-pressed={activeCheckin.critical}
                  onClick={() => void tapCriticalHour()}
                  className={cn(
                    "mt-4 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
                    criticalArmed
                      ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                      : activeCheckin.critical
                        ? "border-green-400/30 bg-green-400/10 text-green-300"
                        : "border-white/10 text-zinc-300 hover:border-white/20 hover:bg-white/[0.03]",
                    criticalPending && "cursor-wait opacity-80"
                  )}
                >
                  <Star
                    className={cn(
                      "size-3",
                      criticalArmed ? "fill-zinc-950 text-zinc-950" : activeCheckin.critical ? "fill-green-300 text-green-300" : "text-zinc-500"
                    )}
                    aria-hidden
                  />
                  {criticalLabel(criticalArmed, activeCheckin.critical)}
                  <ConfirmAffordance armed={criticalArmed} pending={criticalPending} />
                </button>
              ) : null}

              {selectedSignals.length > 0 ? (
                <>
                  <div ref={tagsRef} className="mt-5 flex flex-wrap gap-1.5">
                    {selectedSignals.map((signal) => {
                      const isArmed = armed?.field === signal.field;
                      const on = isArmed ? Boolean(armed.value) : signal.on;
                      const Icon = on ? signal.onIcon : signal.offIcon;
                      return (
                        <button
                          key={signal.field}
                          type="button"
                          disabled={pending}
                          onClick={() => void tapBooleanSignal(signal)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
                            isArmed
                              ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                              : "border-white/10 text-zinc-300 hover:border-white/20 hover:bg-white/[0.03]",
                            pending && "cursor-wait opacity-80"
                          )}
                        >
                          <Icon className={cn("size-3", isArmed ? "text-zinc-950" : "text-zinc-500")} aria-hidden />
                          {on ? signal.onLabel : signal.offLabel}
                          <ConfirmAffordance armed={isArmed} pending={pending} />
                        </button>
                      );
                    })}
                    {shownPosture ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void tapPosture()}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
                          armed?.field === "posture"
                            ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                            : "border-white/10 text-zinc-300 hover:border-white/20 hover:bg-white/[0.03]",
                          pending && "cursor-wait opacity-80"
                        )}
                      >
                        {shownPosture}
                        <ConfirmAffordance armed={armed?.field === "posture"} pending={pending} />
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
              {selected?.note ? <p className="mt-4 text-sm leading-6 text-zinc-400">{selected.note}</p> : null}
            </div>
        </div>
      </div>

      <div className="mt-6 mb-4 flex items-center gap-1">
        <Button size="sm" className={tab === "today" ? "bg-white text-black" : "bg-transparent text-zinc-500"} onClick={() => setTab("today")}>
          Today
        </Button>
        <Button size="sm" className={tab === "average" ? "bg-white text-black" : "bg-transparent text-zinc-500"} onClick={() => setTab("average")}>
          Average
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label} className="border border-white/[0.06] bg-card">
            <Card.Content className="px-4 py-4">
              <p className="text-[11px] tracking-[0.14em] text-zinc-500 uppercase">{metric.label}</p>
              <p className="mt-3 text-4xl leading-none font-semibold tracking-[-0.04em] text-zinc-50">
                <Num>{metric.value}</Num>
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                {metric.delta ? (
                  <>
                    <Num
                      className={cn(
                        "font-medium",
                        metric.deltaSign === "up" && "text-green-400",
                        metric.deltaSign === "down" && "text-red-400",
                        metric.deltaSign === "zero" && "text-zinc-400"
                      )}
                    >
                      {metric.delta}
                    </Num>{" "}
                    {metric.deltaNote}
                  </>
                ) : (
                  metric.deltaNote
                )}
              </p>
            </Card.Content>
          </Card>
        ))}
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{data.isToday ? "Today" : data.viewDayLabel}</h3>
          </div>
          <span className="text-xs text-zinc-500">
            <Num>{String(data.hourly.length)}</Num> check-ins
          </span>
        </div>
        <BarChart
          data={chartData}
          index="label"
          categories={["score"]}
          colors={["bright"]}
          valueFormatter={(value) => String(value)}
          className="h-56"
          markKey="critical"
          onBarSelect={(datum) => {
            const next = datum.hour;
            if (typeof next === "number") {
              setSelectedHour(next);
            }
          }}
        />
      </div>

      <div className="mt-6">
        <DayHeatmap history={data.history} today={data.today} viewDay={data.viewDay} />
      </div>
    </main>
  );
}
