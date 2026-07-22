"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Sparkles, X } from "lucide-react";
import { LedgerDayReport } from "@/components/LedgerDayReport";
import { WeeklyGoalsEditor } from "@/components/WeeklyGoalsEditor";
import type { SaveState } from "@/components/LedgerDayReport";
import { Num } from "@/components/Num";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { dailyValue, weeklyProgress } from "@/lib/ledger";
import type { LedgerData, LedgerDay } from "@/lib/ledger";
import { clampReachouts, ledgerDayAriaLabel } from "@/lib/ledger-ui";
import { cn } from "@/lib/utils";
import { appSlow, appSpring, motionTransition, pressSpring, traySpring } from "./MotionPrimitives";

const LedgerCharts = dynamic(() => import("@/components/LedgerCharts").then((mod) => mod.LedgerCharts), {
  ssr: false,
  loading: () => <div className="h-[230px] rounded-2xl bg-white/[0.02]" />
});

export type LedgerProps = {
  data: LedgerData;
};

const WEEKDAY_COLUMNS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function mondayIndex(dayKey: string): number {
  return (new Date(`${dayKey}T12:00:00Z`).getUTCDay() + 6) % 7;
}

// A nudge message's local clock time (e.g. "3:04 PM"). suppressHydrationWarning
// on the render site covers the server/client time-zone difference.
function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Color ramp for a day cell from its 0–100 score; out-of-range padding cells stay
// nearly invisible so the eye only reads real history.
function dayTone(day: LedgerDay): string {
  if (!day.inRange) {
    return "bg-white/[0.012] text-transparent";
  }
  if (day.dailyValue >= 90) {
    return "bg-emerald-400/22 text-emerald-50";
  }
  if (day.dailyValue >= 70) {
    return "bg-teal-400/16 text-zinc-50";
  }
  if (day.dailyValue >= 50) {
    return "bg-amber-400/16 text-zinc-50";
  }
  if (day.dailyValue > 0) {
    return "bg-rose-400/16 text-zinc-50";
  }
  return "bg-zinc-900/60 text-zinc-300";
}

// The Ledger: a compact, recent, week-grouped history. The grid stays in place,
// the selected day flips to its numbers, and a side/bottom report edits it.
export function Ledger({ data }: LedgerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const [hydrated, setHydrated] = useState(false);
  // Reduced motion only after hydration, so the first client render matches the
  // server's (which can't read the media query) — avoids React #418.
  const reduceMotion = hydrated && prefersReducedMotion;
  const [selectedDay, setSelectedDay] = useState(data.today);
  const [trayOpen, setTrayOpen] = useState(false);
  const [chartMode, setChartMode] = useState<"daily" | "weekly">("daily");
  const [reachoutsDraft, setReachoutsDraft] = useState<Record<string, number>>({});
  const [featureDoneDraft, setFeatureDoneDraft] = useState<Record<string, boolean>>({});
  const [reachoutsState, setReachoutsState] = useState<Record<string, SaveState>>({});
  const [featureState, setFeatureState] = useState<Record<string, SaveState>>({});
  const [repliesDraft, setRepliesDraft] = useState<Record<string, number>>({});
  const [meetingsDraft, setMeetingsDraft] = useState<Record<string, number>>({});
  const [repliesState, setRepliesState] = useState<Record<string, SaveState>>({});
  const [meetingsState, setMeetingsState] = useState<Record<string, SaveState>>({});
  const [breatheDay, setBreatheDay] = useState<string | null>(null);
  const [sessionRequired, setSessionRequired] = useState(false);
  const [intro, setIntro] = useState(true);
  const [isWide, setIsWide] = useState(false);
  const reachoutTimers = useRef<Record<string, number>>({});
  const repliesTimers = useRef<Record<string, number>>({});
  const meetingsTimers = useRef<Record<string, number>>({});
  const breatheTimer = useRef<number | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const sync = () => setIsWide(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setHydrated(true);
    const frame = window.requestAnimationFrame(() => setIntro(false));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    return () => {
      Object.values(reachoutTimers.current).forEach((timer) => window.clearTimeout(timer));
      Object.values(repliesTimers.current).forEach((timer) => window.clearTimeout(timer));
      Object.values(meetingsTimers.current).forEach((timer) => window.clearTimeout(timer));
      if (breatheTimer.current !== null) {
        window.clearTimeout(breatheTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!data.days.some((day) => day.day === selectedDay)) {
      setSelectedDay(data.today);
      setTrayOpen(false);
    }
  }, [data.days, data.today, selectedDay]);

  // Quiet background refresh so live hours land without replaying the entrance.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        startTransition(() => router.refresh());
      }
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [router, startTransition]);

  // After a save reconciles, drop the optimistic draft so an external change to
  // the same day is no longer shadowed.
  useEffect(() => {
    setReachoutsDraft((draft) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [day, value] of Object.entries(draft)) {
        const serverDay = data.days.find((entry) => entry.day === day);
        if (!serverDay || serverDay.reachouts === value) {
          changed = true;
          continue;
        }
        next[day] = value;
      }
      return changed ? next : draft;
    });
    setFeatureDoneDraft((draft) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [day, value] of Object.entries(draft)) {
        const serverDay = data.days.find((entry) => entry.day === day);
        if (!serverDay || serverDay.featureDone === value) {
          changed = true;
          continue;
        }
        next[day] = value;
      }
      return changed ? next : draft;
    });
    setRepliesDraft((draft) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [day, value] of Object.entries(draft)) {
        const serverDay = data.days.find((entry) => entry.day === day);
        if (!serverDay || serverDay.replies === value) {
          changed = true;
          continue;
        }
        next[day] = value;
      }
      return changed ? next : draft;
    });
    setMeetingsDraft((draft) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [day, value] of Object.entries(draft)) {
        const serverDay = data.days.find((entry) => entry.day === day);
        if (!serverDay || serverDay.meetings === value) {
          changed = true;
          continue;
        }
        next[day] = value;
      }
      return changed ? next : draft;
    });
  }, [data.days]);

  const viewDays = useMemo(
    () =>
      data.days.map((day) => {
        const nextReachouts = reachoutsDraft[day.day] ?? day.reachouts;
        const nextFeatureDone = featureDoneDraft[day.day] ?? day.featureDone;
        const nextReplies = repliesDraft[day.day] ?? day.replies;
        const nextMeetings = meetingsDraft[day.day] ?? day.meetings;
        if (
          nextReachouts === day.reachouts &&
          nextFeatureDone === day.featureDone &&
          nextReplies === day.replies &&
          nextMeetings === day.meetings
        ) {
          return day;
        }
        return {
          ...day,
          reachouts: nextReachouts,
          featureDone: nextFeatureDone,
          replies: nextReplies,
          meetings: nextMeetings,
          dailyValue: day.inRange ? dailyValue(nextReachouts, day.hours, nextFeatureDone) : 0,
          active: day.inRange && (nextReachouts > 0 || day.hours > 0 || nextFeatureDone)
        };
      }),
    [data.days, featureDoneDraft, meetingsDraft, reachoutsDraft, repliesDraft]
  );

  const viewDayMap = useMemo(() => new Map(viewDays.map((day) => [day.day, day])), [viewDays]);

  const viewWeeks = useMemo(
    () =>
      data.weeks.map((week) => {
        const days = week.days.map((day) => viewDayMap.get(day.day) ?? day);
        const elapsed = days.filter((day) => day.inRange);
        const reachouts = elapsed.reduce((sum, day) => sum + day.reachouts, 0);
        const hours = Math.round(elapsed.reduce((sum, day) => sum + day.hours, 0) * 10) / 10;
        const features = elapsed.filter((day) => day.featureDone).length;
        const replies = elapsed.reduce((sum, day) => sum + day.replies, 0);
        const meetings = elapsed.reduce((sum, day) => sum + day.meetings, 0);
        const commits = elapsed.reduce((sum, day) => sum + day.commits, 0);
        const merges = elapsed.reduce((sum, day) => sum + day.merges, 0);
        const replyRate = reachouts > 0 ? replies / reachouts : 0;
        const bookingRate = replies > 0 ? meetings / replies : 0;
        const progress = weeklyProgress(reachouts, hours, features, {
          reachouts: week.reachoutsTarget,
          hours: week.hoursTarget,
          features: data.targets.weeklyFeatures
        });
        return { ...week, days, reachouts, hours, features, replies, meetings, commits, merges, replyRate, bookingRate, ...progress };
      }),
    [data.targets.weeklyFeatures, data.weeks, viewDayMap]
  );

  const weekdayAverages = useMemo(() => {
    const sums = new Array(7).fill(0) as number[];
    const counts = new Array(7).fill(0) as number[];
    for (const day of viewDays) {
      if (!day.inRange) {
        continue;
      }
      const idx = mondayIndex(day.day);
      sums[idx] += day.dailyValue;
      counts[idx] += 1;
    }
    return WEEKDAY_COLUMNS.map((weekday, index) => ({
      weekday,
      averageValue: counts[index] > 0 ? Math.round(sums[index] / counts[index]) : 0
    }));
  }, [viewDays]);

  const dailyRows = useMemo(() => {
    const elapsed = viewDays.filter((day) => day.inRange);
    return elapsed.map((day, index) => ({
      day: day.day,
      label: day.label.split(" ")[1],
      dailyValue: day.dailyValue,
      movingAverage7:
        index >= 6 ? Math.round(elapsed.slice(index - 6, index + 1).reduce((sum, item) => sum + item.dailyValue, 0) / 7) : null
    }));
  }, [viewDays]);

  const weeklyRows = useMemo(
    () =>
      viewWeeks
        .filter((week) => week.days.some((day) => day.inRange))
        .map((week) => ({
          weekStart: week.weekStart,
          label: week.label,
          weeklyValue: week.weeklyValue,
          reachouts: week.reachouts,
          hours: week.hours,
          features: week.features,
          reachoutsTarget: week.reachoutsTarget,
          hoursTarget: week.hoursTarget,
          featuresTarget: data.targets.weeklyFeatures
        })),
    [data.targets.weeklyFeatures, viewWeeks]
  );

  const goalWeeks = useMemo(
    () =>
      viewWeeks
        .filter((week) => week.days.some((day) => day.inRange))
        .map((week) => ({
          weekStart: week.weekStart,
          label: week.label,
          reachoutsTarget: week.reachoutsTarget,
          hoursTarget: week.hoursTarget
        })),
    [viewWeeks]
  );
  const selectedDayData = viewDayMap.get(selectedDay) ?? null;
  const currentWeek = viewWeeks.find((week) => week.days.some((day) => day.day === data.today)) ?? viewWeeks[viewWeeks.length - 1] ?? null;
  const summaryWeek = currentWeek;
  const selectedReachouts = selectedDayData?.reachouts ?? 0;
  const selectedFeatureDone = selectedDayData?.featureDone ?? false;
  const reachoutSaveState = selectedDayData ? reachoutsState[selectedDayData.day] ?? "idle" : "idle";
  const featureSaveState = selectedDayData ? featureState[selectedDayData.day] ?? "idle" : "idle";
  const selectedReplies = selectedDayData?.replies ?? 0;
  const selectedMeetings = selectedDayData?.meetings ?? 0;
  const repliesSaveState = selectedDayData ? repliesState[selectedDayData.day] ?? "idle" : "idle";
  const meetingsSaveState = selectedDayData ? meetingsState[selectedDayData.day] ?? "idle" : "idle";

  function beginDaySelection(day: string) {
    if (selectedDay === day && trayOpen) {
      setTrayOpen(false);
      return;
    }
    setSelectedDay(day);
    setTrayOpen(true);
  }

  async function persistLedgerUpdate(day: string, body: { reachouts?: number; featureDone?: boolean; replies?: number; meetings?: number }) {
    const response = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, ...body })
    });
    if (!response.ok) {
      if (response.status === 401) {
        setSessionRequired(true);
        throw new Error("AUTH_REQUIRED");
      }
      let message = "Could not save.";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) {
          message = payload.error;
        }
      } catch {
        // Keep the generic message when the server response isn't JSON.
      }
      throw new Error(message);
    }
    startTransition(() => router.refresh());
  }

  async function authenticateOwner(secret: string) {
    const response = await fetch("/api/ledger/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret })
    });
    if (!response.ok) {
      throw new Error("AUTH_FAILED");
    }
    setSessionRequired(false);
  }

  async function persistWeeklyGoal(weekStart: string, reachouts: number, hours: number) {
    const response = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekStart, weeklyReachouts: reachouts, weeklyHours: hours })
    });
    if (!response.ok) {
      if (response.status === 401) {
        setSessionRequired(true);
        throw new Error("AUTH_REQUIRED");
      }
      let message = "Could not save.";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) {
          message = payload.error;
        }
      } catch {
        // Keep the generic message when the server response isn't JSON.
      }
      throw new Error(message);
    }
    startTransition(() => router.refresh());
  }

  function celebrateIfPerfect(day: string, reachouts: number, hours: number, featureDone: boolean) {
    if (dailyValue(reachouts, hours, featureDone) !== 100) {
      return;
    }
    if (breatheTimer.current !== null) {
      window.clearTimeout(breatheTimer.current);
    }
    setBreatheDay(day);
    breatheTimer.current = window.setTimeout(() => {
      setBreatheDay((current) => (current === day ? null : current));
      breatheTimer.current = null;
    }, 900);
  }

  function scheduleReachoutsSave(day: string, value: number) {
    window.clearTimeout(reachoutTimers.current[day]);
    reachoutTimers.current[day] = window.setTimeout(async () => {
      try {
        await persistLedgerUpdate(day, { reachouts: value });
        const hours = viewDayMap.get(day)?.hours ?? 0;
        const featureDone = featureDoneDraft[day] ?? viewDayMap.get(day)?.featureDone ?? false;
        celebrateIfPerfect(day, value, hours, featureDone);
        setReachoutsState((state) => ({ ...state, [day]: "idle" }));
      } catch {
        setReachoutsState((state) => ({ ...state, [day]: "error" }));
      }
    }, 360);
  }

  function handleReachoutsChange(nextValue: number) {
    if (!selectedDayData) {
      return;
    }
    const value = clampReachouts(nextValue);
    setReachoutsDraft((draft) => ({ ...draft, [selectedDayData.day]: value }));
    setReachoutsState((state) => ({ ...state, [selectedDayData.day]: "saving" }));
    scheduleReachoutsSave(selectedDayData.day, value);
  }

  async function handleReachoutsRetry() {
    if (!selectedDayData) {
      return;
    }
    setReachoutsState((state) => ({ ...state, [selectedDayData.day]: "saving" }));
    try {
      await persistLedgerUpdate(selectedDayData.day, { reachouts: selectedReachouts });
      celebrateIfPerfect(selectedDayData.day, selectedReachouts, selectedDayData.hours, selectedFeatureDone);
      setReachoutsState((state) => ({ ...state, [selectedDayData.day]: "idle" }));
    } catch {
      setReachoutsState((state) => ({ ...state, [selectedDayData.day]: "error" }));
    }
  }

  async function handleFeatureDoneChange(nextValue: boolean) {
    if (!selectedDayData) {
      return;
    }
    setFeatureDoneDraft((draft) => ({ ...draft, [selectedDayData.day]: nextValue }));
    setFeatureState((state) => ({ ...state, [selectedDayData.day]: "saving" }));
    try {
      await persistLedgerUpdate(selectedDayData.day, { featureDone: nextValue });
      celebrateIfPerfect(selectedDayData.day, selectedReachouts, selectedDayData.hours, nextValue);
      setFeatureState((state) => ({ ...state, [selectedDayData.day]: "idle" }));
    } catch {
      setFeatureState((state) => ({ ...state, [selectedDayData.day]: "error" }));
    }
  }

  async function handleFeatureRetry() {
    if (!selectedDayData) {
      return;
    }
    setFeatureState((state) => ({ ...state, [selectedDayData.day]: "saving" }));
    try {
      await persistLedgerUpdate(selectedDayData.day, { featureDone: selectedFeatureDone });
      celebrateIfPerfect(selectedDayData.day, selectedReachouts, selectedDayData.hours, selectedFeatureDone);
      setFeatureState((state) => ({ ...state, [selectedDayData.day]: "idle" }));
    } catch {
      setFeatureState((state) => ({ ...state, [selectedDayData.day]: "error" }));
    }
  }

  // Replies and meetings reuse reachouts' optimistic-draft + debounced-save +
  // inline-retry machinery, parameterized by field. Neither feeds the daily
  // score, so there is no celebrate step — just persist and reconcile.
  const countHooks = {
    replies: { setDraft: setRepliesDraft, setSave: setRepliesState, timers: repliesTimers },
    meetings: { setDraft: setMeetingsDraft, setSave: setMeetingsState, timers: meetingsTimers }
  } as const;

  function scheduleCountSave(field: "replies" | "meetings", day: string, value: number) {
    const { setSave, timers } = countHooks[field];
    window.clearTimeout(timers.current[day]);
    timers.current[day] = window.setTimeout(async () => {
      try {
        await persistLedgerUpdate(day, field === "replies" ? { replies: value } : { meetings: value });
        setSave((state) => ({ ...state, [day]: "idle" }));
      } catch {
        setSave((state) => ({ ...state, [day]: "error" }));
      }
    }, 360);
  }

  function handleCountChange(field: "replies" | "meetings", nextValue: number) {
    if (!selectedDayData) {
      return;
    }
    const value = clampReachouts(nextValue);
    const { setDraft, setSave } = countHooks[field];
    setDraft((draft) => ({ ...draft, [selectedDayData.day]: value }));
    setSave((state) => ({ ...state, [selectedDayData.day]: "saving" }));
    scheduleCountSave(field, selectedDayData.day, value);
  }

  async function handleCountRetry(field: "replies" | "meetings") {
    if (!selectedDayData) {
      return;
    }
    const value = field === "replies" ? selectedReplies : selectedMeetings;
    const { setSave } = countHooks[field];
    setSave((state) => ({ ...state, [selectedDayData.day]: "saving" }));
    try {
      await persistLedgerUpdate(selectedDayData.day, field === "replies" ? { replies: value } : { meetings: value });
      setSave((state) => ({ ...state, [selectedDayData.day]: "idle" }));
    } catch {
      setSave((state) => ({ ...state, [selectedDayData.day]: "error" }));
    }
  }

  const summaryStats = summaryWeek
    ? [
        { label: "Messages", value: summaryWeek.reachouts, target: summaryWeek.reachoutsTarget, pct: summaryWeek.reachoutsPct, accent: "from-blue-400/80 to-sky-300/90" },
        { label: "Hours", value: summaryWeek.hours, target: summaryWeek.hoursTarget, pct: summaryWeek.hoursPct, accent: "from-teal-400/80 to-emerald-300/90" },
        { label: "Features", value: summaryWeek.features, target: data.targets.weeklyFeatures, pct: summaryWeek.featuresPct, accent: "from-fuchsia-400/80 to-pink-300/90" }
      ]
    : [];

  const dayReportPanel = selectedDayData ? (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{selectedDayData.weekdayLabel} · {selectedDayData.label}</p>
          <div className="mt-1 flex items-end gap-2">
            <span className="text-xs text-zinc-500">Day score</span>
            <Num className="text-3xl font-semibold leading-none text-zinc-50">{String(selectedDayData.dailyValue)}</Num>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setTrayOpen(false)}
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:border-white/[0.14] hover:text-zinc-100 active:scale-[0.96]"
          aria-label="Close day report"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 px-4 py-4">
        <LedgerDayReport
          day={selectedDayData}
          reachouts={selectedReachouts}
          onReachoutsChange={handleReachoutsChange}
          onReachoutsRetry={handleReachoutsRetry}
          reachoutsState={reachoutSaveState}
          replies={selectedReplies}
          onRepliesChange={(value) => handleCountChange("replies", value)}
          onRepliesRetry={() => handleCountRetry("replies")}
          repliesState={repliesSaveState}
          meetings={selectedMeetings}
          onMeetingsChange={(value) => handleCountChange("meetings", value)}
          onMeetingsRetry={() => handleCountRetry("meetings")}
          meetingsState={meetingsSaveState}
          featureDone={selectedFeatureDone}
          onFeatureDoneChange={handleFeatureDoneChange}
          onFeatureRetry={handleFeatureRetry}
          featureState={featureSaveState}
          dailyReachoutTarget={data.targets.dailyReachoutReference}
          dailyHoursTarget={data.targets.dailyHoursReference}
        />
      </div>
    </div>
  ) : null;

  return (
    <main className="mx-auto max-w-5xl px-5 py-5">
      <div className="space-y-4">
        {summaryWeek ? (
          <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Week of {summaryWeek.label}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  <Num animate={false}>{String(data.totals.activeDays)}</Num> active days · <Num animate={false}>{String(data.totals.activeDayStreak)}</Num> day streak
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/20 px-3 py-1.5">
                <span className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Score</span>
                <Num className="text-lg font-semibold text-zinc-50">{String(summaryWeek.weeklyValue)}</Num>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {summaryStats.map((stat) => (
                <div key={stat.label}>
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-[11px] uppercase tracking-[0.1em] text-zinc-500">{stat.label}</span>
                  </div>
                  <div className="mt-1 flex items-end gap-1">
                    <Num className="text-2xl font-semibold leading-none text-zinc-50">
                      {Number.isInteger(stat.value) ? String(stat.value) : stat.value.toFixed(1)}
                    </Num>
                    <span className="pb-0.5 text-xs text-zinc-500">/ {stat.target}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <motion.div
                      className={cn("h-full origin-left rounded-full bg-gradient-to-r", stat.accent)}
                      initial={reduceMotion || !intro ? false : { scaleX: 0 }}
                      animate={{ scaleX: stat.pct }}
                      transition={motionTransition(reduceMotion, appSpring)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-zinc-400">
              Reply rate <span className="text-zinc-200">{Math.round(summaryWeek.replyRate * 100)}%</span> · <span className="text-zinc-200">{summaryWeek.meetings}</span> meetings (<span className="text-zinc-200">{Math.round(summaryWeek.bookingRate * 100)}%</span> of replies) · <span className="text-zinc-200">{summaryWeek.commits}</span> commits · <span className="text-zinc-200">{summaryWeek.merges}</span> merges
            </p>
          </section>
        ) : null}
        {summaryWeek ? (
          <WeeklyGoalsEditor
            weeks={goalWeeks}
            initialWeekStart={summaryWeek.weekStart}
            sessionRequired={sessionRequired}
            onSave={persistWeeklyGoal}
            onAuthenticate={authenticateOwner}
          />
        ) : null}

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">Trend</h2>
            <LayoutGroup id="ledger-trend-toggle">
              <div className="flex items-center gap-1 rounded-full bg-black/20 p-0.5">
                {(["daily", "weekly"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setChartMode(mode)}
                    className={cn("relative rounded-full px-3 py-1 text-xs capitalize transition-colors", chartMode === mode ? "text-black" : "text-zinc-400 hover:text-zinc-200")}
                  >
                    {chartMode === mode && (
                      <motion.span layoutId={reduceMotion ? undefined : "ledger-trend-pill"} className="absolute inset-0 rounded-full bg-white" transition={motionTransition(reduceMotion, appSpring)} />
                    )}
                    <span className="relative z-10">{mode}</span>
                  </button>
                ))}
              </div>
            </LayoutGroup>
          </div>
          <LedgerCharts
            mode={chartMode}
            dailyRows={dailyRows}
            weeklyRows={weeklyRows}
            selectedDay={selectedDay}
            reduceMotion={reduceMotion}
            intro={intro}
          />
        </section>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-100">Weekday averages</h2>
          <div className="grid grid-cols-7 gap-2">
            {weekdayAverages.map((average, index) => (
              <div key={average.weekday} className="flex flex-col items-center gap-2">
                <div className="relative h-24 w-full overflow-hidden rounded-xl bg-white/[0.04]">
                  <motion.div
                    className="absolute inset-x-0 bottom-0 rounded-t-[10px] bg-gradient-to-t from-cyan-300/95 via-teal-300/85 to-indigo-400/55"
                    initial={reduceMotion || !intro ? false : { height: 0 }}
                    animate={{ height: `${Math.max(3, average.averageValue)}%` }}
                    transition={motionTransition(reduceMotion, { ...appSpring, delay: intro ? index * 0.04 : 0 })}
                  />
                </div>
                <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-500">{average.weekday}</div>
                <div className="text-sm font-medium text-zinc-100"><Num>{String(average.averageValue)}</Num></div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">History</h2>
            <p className="text-[11px] text-zinc-500">Tap a day to log it.</p>
          </div>
          <div className="grid grid-cols-[28px_repeat(7,minmax(0,1fr))] gap-1">
            <div />
            {WEEKDAY_COLUMNS.map((weekday) => (
              <div key={weekday} className="pb-1 text-center text-[10px] uppercase tracking-[0.08em] text-zinc-500">{weekday}</div>
            ))}
            {viewWeeks.map((week, weekIndex) => {
              const railMonth = week.days[0].monthKey;
              const prevRailMonth = weekIndex > 0 ? viewWeeks[weekIndex - 1].days[0].monthKey : null;
              const showRail = railMonth !== prevRailMonth;
              return (
                <Fragment key={week.weekStart}>
                  <div className="flex items-center justify-end pr-1 text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
                    {showRail ? week.days[0].monthLabel : ""}
                  </div>
                  {week.days.map((day, columnIndex) => {
                    const isSelected = day.day === selectedDay && trayOpen;
                    const isToday = day.day === data.today;
                    const aboveMonth = weekIndex > 0 ? viewWeeks[weekIndex - 1].days[columnIndex]?.monthKey : undefined;
                    const belowMonth = weekIndex < viewWeeks.length - 1 ? viewWeeks[weekIndex + 1].days[columnIndex]?.monthKey : undefined;
                    const leftMonth = columnIndex > 0 ? week.days[columnIndex - 1].monthKey : undefined;
                    const rightMonth = columnIndex < 6 ? week.days[columnIndex + 1].monthKey : undefined;
                    const monthTop = day.inRange && aboveMonth !== undefined && aboveMonth !== day.monthKey;
                    const monthBottom = day.inRange && belowMonth !== undefined && belowMonth !== day.monthKey;
                    const monthLeft = day.inRange && leftMonth !== undefined && leftMonth !== day.monthKey;
                    const monthRight = day.inRange && rightMonth !== undefined && rightMonth !== day.monthKey;
                    const valueFace = (
                      <div className="flex h-full flex-col justify-between p-1.5">
                        <div className="flex items-start justify-between">
                          <span className="text-[9px] font-medium text-zinc-400">{day.inRange ? day.dayOfMonth : ""}</span>
                          {day.inRange && day.featureDone ? <Sparkles className="size-2.5 text-amber-300" aria-hidden /> : null}
                        </div>
                        {day.inRange ? <Num className="self-end text-base font-semibold leading-none">{String(day.dailyValue)}</Num> : null}
                      </div>
                    );

                    return (
                      <motion.button
                        key={day.day}
                        type="button"
                        disabled={!day.inRange}
                        aria-label={day.inRange ? ledgerDayAriaLabel(day) : undefined}
                        aria-pressed={isSelected}
                        onClick={() => day.inRange && beginDaySelection(day.day)}
                        whileTap={reduceMotion || !day.inRange ? undefined : { scale: 0.95 }}
                        transition={motionTransition(reduceMotion, pressSpring)}
                        className={cn(
                          "relative h-14 rounded-[10px] border border-white/[0.04] [perspective:700px] transition-colors",
                          dayTone(day),
                          day.inRange ? "cursor-pointer hover:border-white/20" : "cursor-default",
                          monthTop && "!border-t-2 !border-t-white/55",
                          monthBottom && "!border-b-2 !border-b-white/55",
                          monthLeft && "!border-l-2 !border-l-white/55",
                          monthRight && "!border-r-2 !border-r-white/55",
                          isSelected && "ring-2 ring-white/90",
                          isToday && !isSelected && "ring-1 ring-cyan-400/60"
                        )}
                      >
                        <div className="absolute inset-0 overflow-hidden rounded-[10px]">{valueFace}</div>
                        {breatheDay === day.day ? (
                          <motion.span
                            initial={reduceMotion ? false : { opacity: 0.6, scale: 0.96 }}
                            animate={{ opacity: 0, scale: 1.1 }}
                            transition={motionTransition(reduceMotion, appSlow)}
                            className="pointer-events-none absolute inset-0 rounded-[10px] border border-emerald-200/70"
                            aria-hidden
                          />
                        ) : null}
                      </motion.button>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        </section>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-100">Nudges</h2>
          {data.messages.length === 0 ? (
            <p className="text-xs text-zinc-500">No nudges yet.</p>
          ) : (
            <ul className="space-y-2">
              {data.messages.map((message) => (
                <li
                  key={message.id}
                  className={cn(
                    "flex items-start gap-2 rounded-2xl border px-3 py-2 text-sm",
                    message.direction === "out"
                      ? "border-white/[0.06] bg-white/[0.02] text-zinc-400"
                      : "border-cyan-400/20 bg-cyan-400/[0.06] text-zinc-100"
                  )}
                >
                  <span aria-hidden className={cn("pt-0.5 text-xs", message.direction === "out" ? "text-zinc-500" : "text-cyan-300")}>
                    {message.direction === "out" ? "↙" : "↗"}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{message.text}</span>
                  <span suppressHydrationWarning className="shrink-0 pt-0.5 text-[11px] tabular-nums text-zinc-500">
                    {formatMessageTime(message.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Sheet open={trayOpen && Boolean(selectedDayData)} onOpenChange={setTrayOpen}>
        {dayReportPanel ? (
          <SheetContent
            side={isWide ? "right" : "bottom"}
            showCloseButton={false}
            className={cn(
              "border-white/[0.08] bg-zinc-950/96 p-0 text-zinc-100 backdrop-blur-xl",
              isWide ? "w-full sm:max-w-[440px]" : "h-[min(76vh,620px)] w-full rounded-t-[28px] rounded-b-none"
            )}
          >
            <motion.div
              initial={reduceMotion ? false : isWide ? { opacity: 0, x: 24 } : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              transition={motionTransition(reduceMotion, traySpring)}
              className="h-full"
            >
              <SheetTitle className="sr-only">Day report</SheetTitle>
              {dayReportPanel}
            </motion.div>
          </SheetContent>
        ) : null}
      </Sheet>
    </main>
  );
}
