"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Headphones, HeadphoneOff, Star, User, UserX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Num } from "@/components/Num";
import { RollingNumber } from "@/components/RollingNumber";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { applySignalCorrection } from "@/lib/feedback";
import { scoreFrom } from "@/lib/score";
import { isQuietHour } from "@/lib/time";
import { shouldReloadForLatestSnapshot } from "@/lib/return-refresh";
import { statusLabels } from "@/lib/status";
import { appQuick, appSpring, motionTransition, pressSpring } from "@/components/MotionPrimitives";
import { cn } from "@/lib/utils";
import type { AverageWindow, Signals, SnapshotRow, TodayStats } from "@/lib/types";
import type { DashboardData } from "@/lib/dashboard";
import { frameStripRange, frameStripStartForSelection, shiftFrameStripWindow } from "@/lib/frame-strip";
import { trend, type Delta } from "@/lib/delta";
import type { AvailableChartColorsKeys } from "@/lib/chartUtils";
// recharts is heavy (~100 kB) and the chart sits below the fold, so load it lazily
// as its own client chunk — it stays out of the dashboard route's first-load JS.
const BarChart = dynamic(() => import("@/components/charts/BarChart").then((mod) => mod.BarChart), {
  ssr: false,
  loading: () => <div className="h-56 w-full animate-pulse rounded-md bg-white/[0.03]" />
});

// Stable references so the memoized BarChart skips re-rendering on dashboard state
// changes (arming a tag, switching frames or tabs) that never touch the chart data.
const CHART_CATEGORIES = ["score"];
const CHART_COLORS: AvailableChartColorsKeys[] = ["bright"];
const formatChartValue = (value: number): string => String(value);
const FRAME_STRIP_FALLBACK_VISIBLE_COUNT = 4;
const FRAME_STRIP_THUMB_WIDTH_PX = 80;
const FRAME_STRIP_GAP_PX = 8;
type FrameStripDirection = -1 | 0 | 1;


type Tab = "today" | "average";

type MetricCard = { label: string; value: number; decimals: 0 | 1; suffix: string } & Delta;

type Armed = { field: "present" | "headphones"; value: boolean };

type EditableSignal = {
  field: "present" | "headphones";
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

// The calendar widget works in browser-local Dates; day keys are the app's
// YYYY-MM-DD strings. Bridge by (de)composing calendar-date PARTS — never
// Date.toISOString(), whose UTC shift would move late-evening picks a day.
function parseDayKey(day: string): Date {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return new Date(year, month - 1, dayOfMonth);
}

function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
function resolveFramePosition(frameIndex: number, frameCount: number): number {
  return frameCount === 0 ? -1 : frameIndex >= 0 ? Math.min(frameIndex, frameCount - 1) : frameCount - 1;
}
function stripOffset(direction: FrameStripDirection, distance: number): number {
  // direction is -1 | 0 | 1, so the signed offset is just the product.
  return direction * distance;
}



function pctText(value: number): string {
  return `${Math.round(value)}%`;
}

function editableSignalsFor(snapshot: SnapshotRow): EditableSignal[] {
  return [
    { field: "present", on: snapshot.present, onLabel: "Present", offLabel: "Away", onIcon: User, offIcon: UserX },
    { field: "headphones", on: snapshot.headphones, onLabel: "Headphones", offLabel: "No headphones", onIcon: Headphones, offIcon: HeadphoneOff }
  ];
}

function todayMetrics(today: TodayStats, previous: TodayStats | null, deltaNote: string): MetricCard[] {
  return [
    { label: "Hours present", value: today.hoursPresent, decimals: 1, suffix: "", ...trend(today.hoursPresent, previous?.hoursPresent ?? null, 1, deltaNote) },
    { label: "Avg focus", value: today.avgScore, decimals: 0, suffix: "%", ...trend(today.avgScore, previous?.avgScore ?? null, 0, deltaNote, "%") },
    { label: "Headphones", value: today.headphonesPct, decimals: 0, suffix: "%", ...trend(today.headphonesPct, previous?.headphonesPct ?? null, 0, deltaNote, "%") },
    { label: "Critical hours", value: today.criticalHours, decimals: 0, suffix: "h", ...trend(today.criticalHours, previous?.criticalHours ?? null, 0, deltaNote) }
  ];
}

function averageMetrics(last7: AverageWindow, previous7: AverageWindow): MetricCard[] {
  const baseline = previous7.days > 0 ? previous7 : null;
  const note = "vs previous 7 days";
  return [
    { label: "Hours present", value: last7.hoursPresent, decimals: 1, suffix: "", ...trend(last7.hoursPresent, baseline?.hoursPresent ?? null, 1, note) },
    { label: "Avg focus", value: last7.avgScore, decimals: 0, suffix: "%", ...trend(last7.avgScore, baseline?.avgScore ?? null, 0, note, "%") },
    { label: "Headphones", value: last7.headphonesPct, decimals: 0, suffix: "%", ...trend(last7.headphonesPct, baseline?.headphonesPct ?? null, 0, note, "%") },
    { label: "Critical hours", value: last7.criticalHours, decimals: 1, suffix: "h", ...trend(last7.criticalHours, baseline?.criticalHours ?? null, 1, note) }
  ];
}

function criticalLabel(armed: boolean, critical: boolean): string {
  if (armed) {
    return critical ? "Remove critical hour" : "Confirm critical hour";
  }
  return critical ? "Critical hour" : "Mark critical hour";
}

// Trailing affordance shown only once a tag is armed: a confirm check. Writes are
// optimistic (instant), so there is no in-flight spinner. Shared by every two-tap toggle.
function ConfirmAffordance({ armed }: { armed: boolean }) {
  if (!armed) {
    return null;
  }
  return <Check className="size-3" aria-hidden />;
}

export function Dashboard({ data }: { data: DashboardData }) {
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const [hydrated, setHydrated] = useState(false);
  // Reduced motion only takes effect AFTER hydration so the first client render
  // matches the server's (which can't read the media query) — no React #418.
  const reduceMotion = hydrated && prefersReducedMotion;
  useRefreshOnReturn();
  const [tab, setTab] = useState<Tab>("today");
  const [selectedHour, setSelectedHour] = useState<number | null>(data.defaultHour);
  const [frameIndex, setFrameIndex] = useState(-1);
  const [frameStripStart, setFrameStripStart] = useState(0);
  const [frameStripVisibleCount, setFrameStripVisibleCount] = useState(FRAME_STRIP_FALLBACK_VISIBLE_COUNT);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [frameStripDirection, setFrameStripDirection] = useState<FrameStripDirection>(0);
  const [criticalArmed, setCriticalArmed] = useState(false);
  const [dayPickerOpen, setDayPickerOpen] = useState(false);
  // Optimistic overlays: a confirmed correction applies locally at once while the
  // write + reconcile run in the background, so a tap never blocks on the server
  // round-trip. Keyed by the row they patch, so a frame or day change discards them
  // and the freshly fetched server values become truth (mirrors the-100's draft).
  const [signalPatch, setSignalPatch] = useState<{ id: string; signals: Signals } | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [criticalPatch, setCriticalPatch] = useState<{ day: string; hour: number; critical: boolean } | null>(null);
  const tagsRef = useRef<HTMLDivElement | null>(null);
  const topPanelRef = useRef<HTMLDivElement | null>(null);
  const frameStripViewportRef = useRef<HTMLDivElement | null>(null);

  const liveSnapshotId = data.isToday ? data.latest?.id : null;

  // Selectable = days that actually have check-ins, plus live today (whose first
  // check-in may not have landed yet). A Set for O(1) calendar `disabled` checks.
  const selectableDays = useMemo(() => new Set([...data.dataDays, data.today]), [data.dataDays, data.today]);

  // Navigates the dashboard to `day`. Today collapses to the bare URL so the
  // canonical live view never carries a ?day= param.
  function goToDay(day: string | null) {
    if (!day) return;
    setDayPickerOpen(false);
    const url = new URL(window.location.href);
    if (day === data.today) {
      url.searchParams.delete("day");
    } else {
      url.searchParams.set("day", day);
    }
    router.replace(url.pathname + url.search);
    router.refresh();
  }

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    const viewport = frameStripViewportRef.current;
    if (!viewport) {
      return;
    }

    const update = () => {
      const width = viewport.clientWidth;
      const nextVisibleCount = Math.max(1, Math.floor((width + FRAME_STRIP_GAP_PX) / (FRAME_STRIP_THUMB_WIDTH_PX + FRAME_STRIP_GAP_PX)));
      setFrameStripVisibleCount((current) => (current === nextVisibleCount ? current : nextVisibleCount));
    };

    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setFrameIndex(-1);
    setFrameStripStart(0);
    setFrameStripDirection(0);
  }, [selectedHour]);

  useEffect(() => {
    setSelectedHour(data.defaultHour);
    setFrameIndex(-1);
    setFrameStripStart(0);
    setFrameStripDirection(0);
    setArmed(null);
    setCriticalArmed(false);
    setSignalPatch(null);
    setCriticalPatch(null);
    setWriteError(null);
  }, [data.viewDay, data.defaultHour, liveSnapshotId]);

  useEffect(() => {
    setArmed(null);
    setCriticalArmed(false);
    setSignalPatch(null);
    setCriticalPatch(null);
    setWriteError(null);
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
  const selectedFramePosition = resolveFramePosition(frameIndex, activeFrames.length);
  const selected = followingLatest && data.latest ? data.latest : selectedFramePosition >= 0 ? (activeFrames[selectedFramePosition] ?? null) : null;

  useEffect(() => {
    if (frameIndex < 0) {
      setFrameStripDirection(0);
      setFrameStripStart(frameStripStartForSelection(activeFrames.length, activeFrames.length - 1, frameStripVisibleCount));
      return;
    }
    setFrameStripDirection(0);
    setFrameStripStart((current) => frameStripRange(activeFrames.length, current, frameStripVisibleCount).start);
  }, [activeFrames.length, activeHour, frameIndex, frameStripVisibleCount, liveSnapshotId]);

  const { start: visibleFrameStart, end: visibleFrameEnd } = frameStripRange(activeFrames.length, frameStripStart, frameStripVisibleCount);
  const visibleFrames = activeFrames.slice(visibleFrameStart, visibleFrameEnd);
  const canPageOlder = visibleFrameStart > 0;
  const canPageNewer = visibleFrameEnd < activeFrames.length;
  const activeCheckin = activeHour === null ? null : data.hourly.find((checkin) => checkin.hour === activeHour) ?? null;
  const stepFrameStrip = useCallback(
    (delta: -1 | 1) => {
      setFrameStripDirection(delta);
      setFrameStripStart((current) => shiftFrameStripWindow(activeFrames.length, current, frameStripVisibleCount, delta));
    },
    [activeFrames.length, frameStripVisibleCount]
  );
  const scrollTopPanelIntoView = useCallback(() => {
    const topPanel = topPanelRef.current;
    if (!topPanel) {
      return;
    }

    const top = topPanel.getBoundingClientRect().top;
    if (top >= 24) {
      return;
    }

    topPanel.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }, [reduceMotion]);


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

  const metrics = tab === "today" ? todayMetrics(data.stats, data.previousStats, data.isToday ? "vs yesterday at this time" : "vs yesterday") : averageMetrics(data.averages.last7, data.averages.previous7);
  // The snapshot as shown: the server row plus any optimistic correction, re-scored
  // exactly as the server will (same scoreFrom) so the hero score and status already
  // match before the background write lands.
  const effectiveSelected = useMemo<SnapshotRow | null>(() => {
    if (!selected) {
      return null;
    }
    if (signalPatch && signalPatch.id === selected.id) {
      const { score, status } = scoreFrom(signalPatch.signals);
      return { ...selected, ...signalPatch.signals, score, status };
    }
    return selected;
  }, [selected, signalPatch]);
  const selectedSignals = effectiveSelected ? editableSignalsFor(effectiveSelected) : [];
  const heroStatus = effectiveSelected ? statusLabels[effectiveSelected.status] : data.statusState.headline;
  const effectiveCritical =
    criticalPatch && activeHour !== null && criticalPatch.day === data.viewDay && criticalPatch.hour === activeHour
      ? criticalPatch.critical
      : (activeCheckin?.critical ?? false);

  function confirmCorrection(field: Armed["field"], value: boolean) {
    if (!effectiveSelected) {
      return;
    }
    const current: Signals = {
      present: effectiveSelected.present,
      headphones: effectiveSelected.headphones,
      eyesOnScreen: effectiveSelected.eyesOnScreen,
      posture: effectiveSelected.posture,
      note: effectiveSelected.note
    };
    setWriteError(null);
    let nextSignals: Signals;
    try {
      nextSignals = applySignalCorrection(current, field, value);
    } catch {
      return;
    }
    const snapshotId = effectiveSelected.id;
    setArmed(null);
    setSignalPatch({ id: snapshotId, signals: nextSignals });
    void persistCorrection(snapshotId, field, value);
  }

  // Background write for an optimistic correction: persist, then router.refresh()
  // reconciles the derived rollups (bar, heatmap, metrics). On failure, drop the
  // patch so the refresh restores the server's value — no silent divergence.
  async function persistCorrection(snapshotId: string, field: Armed["field"], value: boolean) {
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId, field, value })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
    } catch {
      setSignalPatch((patch) => (patch?.id === snapshotId ? null : patch));
      setWriteError("Could not save that correction. Tap again.");
    }
    router.refresh();
  }

  function confirmCriticalHour() {
    if (activeHour === null || !activeCheckin) {
      return;
    }
    setWriteError(null);
    const day = data.viewDay;
    const hour = activeHour;
    const nextCritical = !effectiveCritical;
    setCriticalArmed(false);
    setCriticalPatch({ day, hour, critical: nextCritical });
    void persistCritical(day, hour, nextCritical);
  }

  async function persistCritical(day: string, hour: number, critical: boolean) {
    try {
      const response = await fetch("/api/critical", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ day, hour, critical })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
    } catch {
      setCriticalPatch((patch) => (patch && patch.day === day && patch.hour === hour ? null : patch));
      setWriteError("Could not save the critical hour. Tap again.");
    }
    router.refresh();
  }

  function tapCriticalHour() {
    if (!activeCheckin) {
      return;
    }
    if (criticalArmed) {
      confirmCriticalHour();
      return;
    }
    setCriticalArmed(true);
  }

  function tapBooleanSignal(signal: EditableSignal) {
    if (armed?.field === signal.field) {
      confirmCorrection(signal.field, armed.value);
      return;
    }
    setArmed({ field: signal.field, value: !signal.on });
  }

  const handleBarSelect = useCallback(
    (datum: Record<string, string | number | boolean>) => {
      const next = datum.hour;
      if (typeof next === "number") {
        setSelectedHour(next);
        scrollTopPanelIntoView();
      }
    },
    [scrollTopPanelIntoView]
  );

  return (
    <main className="mx-auto max-w-5xl px-5 py-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-zinc-500 hover:text-zinc-100"
            disabled={!data.prevDay}
            onClick={() => goToDay(data.prevDay)}
            aria-label="Previous day"
          >
            <ChevronLeft />
          </Button>
          <Popover open={dayPickerOpen} onOpenChange={setDayPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="xs" className="gap-1.5 px-1.5 text-sm font-normal text-zinc-500 hover:text-zinc-100">
                <CalendarDays aria-hidden />
                <span className="truncate">{data.isToday ? `Today · ${data.viewDayLabel}` : data.viewDayLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-auto bg-zinc-900 p-0 outline outline-1 -outline-offset-1 outline-white/10 shadow-xl shadow-black/50"
            >
              <Calendar
                mode="single"
                selected={parseDayKey(data.viewDay)}
                defaultMonth={parseDayKey(data.viewDay)}
                startMonth={parseDayKey(data.dataDays.at(-1) ?? data.today)}
                endMonth={parseDayKey(data.today)}
                disabled={(date) => !selectableDays.has(dayKeyOf(date))}
                onSelect={(date) => {
                  if (date) {
                    goToDay(dayKeyOf(date));
                  }
                }}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-zinc-500 hover:text-zinc-100"
            disabled={!data.nextDay}
            onClick={() => goToDay(data.nextDay)}
            aria-label="Next day"
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
          {!data.isToday ? (
            <button
              type="button"
              onClick={() => goToDay(data.today)}
              className="text-xs text-zinc-300 hover:text-zinc-100 transition"
            >
              Back to today
            </button>
          ) : null}
          <span className="size-1.5 rounded-full bg-zinc-400" aria-hidden />
          {data.statusState.lastCheckedText}
        </div>
      </header>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(300px,0.95fr)] lg:items-start">
        <div ref={topPanelRef}>
          <div className="relative aspect-[4/3] max-h-[520px] w-full overflow-hidden rounded-2xl outline outline-1 -outline-offset-1 outline-white/10">
            {selected?.thumbUrl ? (
              <AnimatePresence initial={false}>
                <motion.img
                  key={selected.id}
                  alt={`Snapshot at ${frameTime(selected.capturedAt, data.timeZone)}`}
                  className={cn("absolute inset-0 h-full w-full object-cover", data.settings.blur && "blur-md")}
                  src={selected.thumbUrl}
                  initial={reduceMotion ? false : { opacity: 0, scale: 1.03 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={motionTransition(reduceMotion, appQuick)}
                />
              </AnimatePresence>
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <p className="text-sm font-medium text-zinc-200">Waiting for the next check-in</p>
                <p className="mt-2 max-w-52 text-xs leading-5 text-zinc-500">The frame keeps its place even when capture is quiet, so the page never collapses.</p>
              </div>
            )}
            {isLive ? (
              <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-md bg-black/40 px-2 py-1 text-[10px] font-medium tracking-wide text-zinc-200 backdrop-blur">
                <span className="size-1.5 rounded-full bg-zinc-100" aria-hidden /> LIVE
              </span>
            ) : null}
          </div>
          {activeFrames.length > 0 ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                {canPageOlder ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    aria-label="Show older snapshots"
                    onClick={() => stepFrameStrip(-1)}
                    className="shrink-0 rounded-xl border border-white/10 bg-black/65 text-zinc-100 backdrop-blur transition-colors hover:bg-black/80"
                  >
                    <ChevronLeft />
                  </Button>
                ) : (
                  <div className="size-10 shrink-0" aria-hidden />
                )}
                <div ref={frameStripViewportRef} className="min-w-0 flex-1 overflow-hidden">
                  <div className="grid">
                    <AnimatePresence initial={false} mode="sync">
                      <motion.div
                        key={`${visibleFrameStart}-${visibleFrameEnd}`}
                        className="[grid-area:1/1] flex gap-2"
                        role="listbox"
                        aria-label={`${activeHour ?? 0} snapshots`}
                        initial={reduceMotion ? false : { opacity: 0.84, x: stripOffset(frameStripDirection, 18) }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0.84, x: -stripOffset(frameStripDirection, 18) }}
                        transition={{
                          x: motionTransition(reduceMotion, appSpring),
                          opacity: motionTransition(reduceMotion, appQuick)
                        }}
                      >
                        {visibleFrames.map((frame, offset) => {
                          const position = visibleFrameStart + offset;
                          const isSelectedFrame = position === selectedFramePosition;

                          return (
                            <motion.button
                              key={frame.id}
                              type="button"
                              role="option"
                              aria-selected={isSelectedFrame}
                              aria-label={`Snapshot at ${frameTime(frame.capturedAt, data.timeZone)}, focus ${frame.score}`}
                              onClick={() => setFrameIndex(position)}
                              whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                              transition={motionTransition(reduceMotion, pressSpring)}
                              className={cn(
                                "relative h-14 w-20 shrink-0 overflow-hidden rounded-lg border transition",
                                isSelectedFrame ? "border-zinc-100" : "border-white/10 hover:border-white/20"
                              )}
                            >
                              <img
                                alt=""
                                className={cn("h-14 w-20 object-cover", data.settings.blur && "blur-md")}
                                src={frame.thumbUrl}
                              />
                              <span className="absolute inset-x-0 bottom-0 h-1.5 bg-zinc-300" aria-hidden />
                              <span className="absolute top-1 right-1 rounded bg-black/70 px-1 text-[10px] text-zinc-100">
                                <Num>{String(frame.score)}</Num>
                              </span>
                            </motion.button>
                          );
                        })}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
                {canPageNewer ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    aria-label="Show newer snapshots"
                    onClick={() => stepFrameStrip(1)}
                    className="shrink-0 rounded-xl border border-white/10 bg-black/65 text-zinc-100 backdrop-blur transition-colors hover:bg-black/80"
                  >
                    <ChevronRight />
                  </Button>
                ) : (
                  <div className="size-10 shrink-0" aria-hidden />
                )}
              </div>
              <div className="flex items-center justify-between text-[11px] text-zinc-500">
                <span>
                  Snapshot <Num>{String(selectedFramePosition + 1)}</Num> of <Num>{String(activeFrames.length)}</Num>
                </span>
                <span className="grid text-right">
                  <AnimatePresence initial={false} mode="sync">
                    <motion.span
                      key={`${visibleFrameStart}-${visibleFrameEnd}`}
                      className="[grid-area:1/1]"
                      initial={reduceMotion ? false : { opacity: 0, x: stripOffset(frameStripDirection, 10) }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -stripOffset(frameStripDirection, 10) }}
                      transition={{
                        x: motionTransition(reduceMotion, appSpring),
                        opacity: motionTransition(reduceMotion, appQuick)
                      }}
                    >
                      {`Showing ${visibleFrameStart + 1}-${visibleFrameEnd}`}
                    </motion.span>
                  </AnimatePresence>
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="space-y-6">
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
                  <Num className="text-6xl leading-none font-semibold tracking-[-0.05em] text-zinc-50">{String(effectiveSelected?.score ?? 0)}</Num>
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
              <motion.button
                type="button"
                aria-pressed={effectiveCritical}
                onClick={() => tapCriticalHour()}
                whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                transition={motionTransition(reduceMotion, pressSpring)}
                animate={reduceMotion ? undefined : effectiveCritical && !criticalArmed ? { boxShadow: "0 0 20px rgba(69, 217, 119, 0.3)" } : {}}
                className={cn(
                  "mt-4 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
                  criticalArmed
                    ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                    : effectiveCritical
                      ? "border-green-400/30 bg-green-400/10 text-green-300"
                      : "border-white/10 text-zinc-300 hover:border-white/20 hover:bg-white/[0.03]"
                )}
              >
                <motion.div
                  animate={reduceMotion ? undefined : effectiveCritical && !criticalArmed ? { rotate: 360 } : { rotate: 0 }}
                  transition={motionTransition(reduceMotion, appQuick)}
                >
                  <Star
                    className={cn(
                      "size-3",
                      criticalArmed ? "fill-zinc-950 text-zinc-950" : effectiveCritical ? "fill-green-300 text-green-300" : "text-zinc-500"
                    )}
                    aria-hidden
                  />
                </motion.div>
                {criticalLabel(criticalArmed, effectiveCritical)}
                <ConfirmAffordance armed={criticalArmed} />
              </motion.button>
            ) : null}

            {selectedSignals.length > 0 ? (
              <>
                <div ref={tagsRef} className="mt-5 flex flex-wrap gap-1.5">
                  {selectedSignals.map((signal) => {
                    const isArmed = armed?.field === signal.field;
                    const on = isArmed ? Boolean(armed.value) : signal.on;
                    const Icon = on ? signal.onIcon : signal.offIcon;
                    const label = on ? signal.onLabel : signal.offLabel;
                    return (
                      <motion.button
                        key={signal.field}
                        type="button"
                        onClick={() => tapBooleanSignal(signal)}
                        whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                        transition={motionTransition(reduceMotion, pressSpring)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                          isArmed
                            ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                            : "border-white/10 text-zinc-300 hover:border-white/20 hover:bg-white/[0.03]"
                        )}
                      >
                        <Icon className={cn("size-3", isArmed ? "text-zinc-950" : "text-zinc-500")} aria-hidden />
                        <span className="grid">
                          <AnimatePresence initial={false}>
                            <motion.span
                              key={label}
                              className="[grid-area:1/1] whitespace-nowrap"
                              initial={reduceMotion ? false : { opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={motionTransition(reduceMotion, appQuick)}
                            >
                              {label}
                            </motion.span>
                          </AnimatePresence>
                        </span>
                        <ConfirmAffordance armed={isArmed} />
                      </motion.button>
                    );
                  })}
                </div>
                {writeError ? <p className="mt-4 text-sm text-rose-300">{writeError}</p> : null}
              </>
            ) : null}
            {selected?.note ? <p className="mt-4 text-sm leading-6 text-zinc-400">{selected.note}</p> : null}
          </div>

          <div>
            <LayoutGroup id="dashboard-tabs">
              <div className="mb-3 flex items-center gap-1">
                {(["today", "average"] as const).map((value) => (
                  <motion.button
                    key={value}
                    type="button"
                    onClick={() => setTab(value)}
                    whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                    transition={motionTransition(reduceMotion, pressSpring)}
                    className={cn("relative rounded-full px-3.5 py-2 text-sm transition-colors duration-200", tab === value ? "text-black" : "text-zinc-500")}
                  >
                    {tab === value && (
                      <motion.span
                        layoutId={reduceMotion ? undefined : "dashboard-tab-active"}
                        className="absolute inset-0 rounded-full bg-white"
                        transition={motionTransition(reduceMotion, appSpring)}
                      />
                    )}
                    <span className="relative z-10 capitalize">{value}</span>
                  </motion.button>
                ))}
              </div>
            </LayoutGroup>
            <div className="grid grid-cols-2 gap-3">
              {metrics.map((metric) => (
                <Card key={metric.label} className="border border-white/[0.06] bg-card">
                  <CardContent className="px-4 py-4">
                    <p className="text-[11px] tracking-[0.14em] text-zinc-500 uppercase">{metric.label}</p>
                    <p className="mt-3 text-4xl leading-none font-semibold tracking-[-0.04em] text-zinc-50">
                      <RollingNumber value={metric.value} decimals={metric.decimals} suffix={metric.suffix} />
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
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
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
          categories={CHART_CATEGORIES}
          colors={CHART_COLORS}
          valueFormatter={formatChartValue}
          className="h-56"
          markKey="critical"
          selectedKey={activeHour !== null ? hourTick(activeHour) : undefined}
          onBarSelect={handleBarSelect}
        />
      </div>

    </main>
  );
}
