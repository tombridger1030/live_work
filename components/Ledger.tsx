"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { LedgerDayReport } from "@/components/LedgerDayReport";
import { CodePulse } from "@/components/CodePulse";
import {
  MirrorNotice,
  type MirrorView,
} from "@/components/MirrorNotice";
import { OutreachPipeline } from "@/components/OutreachPipeline";
import { WeeklyGoalsEditor } from "@/components/WeeklyGoalsEditor";
import type { SaveState } from "@/components/LedgerDayReport";
import { Num } from "@/components/Num";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { clampDailyCount, type ManualCountField } from "@/lib/ledger-fields";
import { reassembleLedger } from "@/lib/ledger";
import type { LedgerData, LedgerDay, LedgerDayPatch } from "@/lib/ledger";
import { ledgerDayAriaLabel } from "@/lib/ledger-ui";
import { outreachBarTotal } from "@/lib/outreach-pace";
import { cn } from "@/lib/utils";
import {
  appQuick,
  appSlow,
  appSpring,
  motionTransition,
  pressSpring,
  traySpring,
} from "./MotionPrimitives";

const LedgerCharts = dynamic(
  () => import("@/components/LedgerCharts").then((mod) => mod.LedgerCharts),
  {
    ssr: false,
    loading: () => <div className="h-[230px] rounded-2xl bg-white/[0.02]" />,
  },
);

export type LedgerProps = {
  data: LedgerData;
  /** Saved-copy context. Its presence selects the durable Vercel mutation path. */
  mirror?: MirrorView | null;
};

const WEEKDAY_COLUMNS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SAVE_DEBOUNCE_MS = 360;

type CountDrafts = Record<string, Partial<Record<ManualCountField, number>>>;

const saveKey = (day: string, field: ManualCountField) => `${day}:${field}`;

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
export function Ledger({ data, mirror }: LedgerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const [hydrated, setHydrated] = useState(false);
  // Reduced motion only after hydration, so the first client render matches the
  // server's (which can't read the media query), avoiding React #418.
  const reduceMotion = hydrated && prefersReducedMotion;
  const [selectedDay, setSelectedDay] = useState(data.today);
  const [trayOpen, setTrayOpen] = useState(false);
  const [chartMode, setChartMode] = useState<"daily" | "weekly">("daily");
  // Unsaved counts per day. Drafts re-score through the same reassembly the
  // server uses, so the board, bars, and pipeline move the moment a count does.
  const [drafts, setDrafts] = useState<CountDrafts>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [breatheDay, setBreatheDay] = useState<string | null>(null);
  const [sessionRequired, setSessionRequired] = useState(false);
  const [intro, setIntro] = useState(true);
  const [isWide, setIsWide] = useState(false);
  const saveTimers = useRef<Record<string, number>>({});
  const pendingSaves = useRef<CountDrafts>({});
  // Read by the post-save celebration, which runs after the render that queued it.
  const latest = useRef({ data, drafts });
  useEffect(() => {
    latest.current = { data, drafts };
  }, [data, drafts]);
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
    const timers = saveTimers.current;
    return () => {
      Object.values(timers).forEach((timer) => window.clearTimeout(timer));
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

  // After a save reconciles, drop each draft the server now agrees with so an
  // external change to the same day is no longer shadowed.
  useEffect(() => {
    setDrafts((current) => {
      let changed = false;
      const next: CountDrafts = {};
      for (const [day, fields] of Object.entries(current)) {
        const serverDay = data.days.find((entry) => entry.day === day);
        const kept: Partial<Record<ManualCountField, number>> = {};
        for (const [field, value] of Object.entries(fields) as [ManualCountField, number][]) {
          if (serverDay && serverDay[field] !== value) kept[field] = value;
          else changed = true;
        }
        if (Object.keys(kept).length > 0) next[day] = kept;
      }
      return changed ? next : current;
    });
  }, [data.days]);

  const view = useMemo(
    () => (Object.keys(drafts).length === 0 ? data : reassembleLedger(data, drafts as Record<string, LedgerDayPatch>)),
    [data, drafts],
  );
  const viewWeeks = view.weeks;
  const viewDayMap = useMemo(() => new Map(view.days.map((day) => [day.day, day])), [view.days]);

  const weeklyRows = useMemo(
    () =>
      viewWeeks
        .filter((week) => week.days.some((day) => day.inRange))
        .map((week) => ({
          weekStart: week.weekStart,
          label: week.label,
          weeklyValue: week.weeklyValue,
          touches: week.goal.outreach.kind === "touches" ? week.touches : week.counts.emailsSent + week.counts.connectionRequests,
          hours: week.hours,
          touchesTarget: outreachBarTotal(week.goal.outreach),
          hoursTarget: week.goal.hours,
        })),
    [viewWeeks],
  );

  const goalWeeks = useMemo(
    () =>
      viewWeeks
        .filter((week) => week.days.some((day) => day.inRange))
        .map((week) => ({ weekStart: week.weekStart, label: week.label, goal: week.goal })),
    [viewWeeks],
  );
  const selectedDayData = viewDayMap.get(selectedDay) ?? null;
  const summaryWeek =
    viewWeeks.find((week) => week.days.some((day) => day.day === data.today)) ?? viewWeeks[viewWeeks.length - 1] ?? null;

  function beginDaySelection(day: string) {
    if (selectedDay === day && trayOpen) {
      setTrayOpen(false);
      return;
    }
    setSelectedDay(day);
    setTrayOpen(true);
  }

  async function postLedger(body: Record<string, unknown>) {
    const response = await fetch(mirror ? "/mirror-api/ledger" : "/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    const response = await fetch(
      mirror ? "/mirror-api/ledger/session" : "/api/ledger/session",
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
      },
    );
    if (!response.ok) {
      throw new Error(response.status === 429 ? "AUTH_RATE_LIMITED" : "AUTH_REJECTED");
    }
    setSessionRequired(false);
  }

  function persistWeeklyGoal(weekStart: string, emails: number, connectionRequests: number, hours: number) {
    return postLedger({ weekStart, weeklyEmails: emails, weeklyConnectionRequests: connectionRequests, weeklyHours: hours });
  }

  // A perfect day is perfect against its own bars, read from the same
  // reassembly the board shows. Celebrates only after the save lands.
  function celebrateIfPerfect(day: string) {
    const { data: current, drafts: currentDrafts } = latest.current;
    const scored = reassembleLedger(current, currentDrafts as Record<string, LedgerDayPatch>).days.find((entry) => entry.day === day);
    if (!scored || scored.dailyValue !== 100) {
      return;
    }
    if (breatheTimer.current !== null) {
      window.clearTimeout(breatheTimer.current);
    }
    setBreatheDay(day);
    breatheTimer.current = window.setTimeout(() => {
      setBreatheDay((currentDay) => (currentDay === day ? null : currentDay));
      breatheTimer.current = null;
    }, 900);
  }

  function setFieldStates(day: string, fields: ManualCountField[], state: SaveState) {
    setSaveStates((current) => {
      const next = { ...current };
      for (const field of fields) next[saveKey(day, field)] = state;
      return next;
    });
  }

  // Edits to one day coalesce into a single debounced POST of every changed
  // count, so tapping three steppers sends one request, not three.
  async function flushDay(day: string) {
    const patch = pendingSaves.current[day] ?? {};
    delete pendingSaves.current[day];
    const fields = Object.keys(patch) as ManualCountField[];
    if (fields.length === 0) return;
    try {
      await postLedger({ day, ...patch });
      setFieldStates(day, fields, "idle");
      celebrateIfPerfect(day);
    } catch {
      setFieldStates(day, fields, "error");
    }
  }

  function scheduleSave(day: string, field: ManualCountField, value: number) {
    pendingSaves.current[day] = { ...pendingSaves.current[day], [field]: value };
    setFieldStates(day, [field], "saving");
    window.clearTimeout(saveTimers.current[day]);
    saveTimers.current[day] = window.setTimeout(() => void flushDay(day), SAVE_DEBOUNCE_MS);
  }

  function handleCountChange(field: ManualCountField, nextValue: number) {
    if (!selectedDayData) {
      return;
    }
    const day = selectedDayData.day;
    const value = clampDailyCount(nextValue);
    setDrafts((current) => ({ ...current, [day]: { ...current[day], [field]: value } }));
    scheduleSave(day, field, value);
  }

  function handleCountRetry(field: ManualCountField) {
    if (!selectedDayData) {
      return;
    }
    scheduleSave(selectedDayData.day, field, selectedDayData[field]);
  }

  const saveStateOf = (field: ManualCountField): SaveState =>
    selectedDayData ? (saveStates[saveKey(selectedDayData.day, field)] ?? "idle") : "idle";

  const outreachGoal = summaryWeek?.goal.outreach ?? null;
  const summaryStats = summaryWeek
    ? [
        ...(outreachGoal?.kind === "channels"
          ? [
              {
                label: "Emails",
                value: summaryWeek.counts.emailsSent,
                target: outreachGoal.emails,
                accent: "from-blue-400/80 to-sky-300/90",
              },
              {
                label: "Requests",
                value: summaryWeek.counts.connectionRequests,
                target: outreachGoal.connectionRequests,
                accent: "from-sky-400/80 to-cyan-300/90",
              },
            ]
          : [
              {
                label: "Touches",
                value: summaryWeek.touches,
                target: outreachGoal?.touches ?? 0,
                accent: "from-blue-400/80 to-sky-300/90",
              },
            ]),
        {
          label: "Hours",
          value: summaryWeek.hours,
          target: summaryWeek.goal.hours,
          accent: "from-teal-400/80 to-emerald-300/90",
        },
      ].map((stat) => ({ ...stat, pct: stat.target > 0 ? Math.min(1, stat.value / stat.target) : 1 }))
    : [];

  const dayReportPanel = selectedDayData ? (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            {selectedDayData.weekdayLabel} · {selectedDayData.label}
          </p>
          <div className="mt-1 flex items-end gap-2">
            <span className="text-xs text-zinc-500">Activity score</span>
            <Num className="text-3xl font-semibold leading-none text-zinc-50">
              {String(selectedDayData.dailyValue)}
            </Num>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setTrayOpen(false)}
          className="inline-flex size-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:border-white/[0.14] hover:text-zinc-100 active:scale-[0.96]"
          aria-label="Close day report"
        >
          <X className="size-4" />
        </button>
      </div>
      <div
        data-day-report-scroll
        className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable]"
      >
        <LedgerDayReport
          sessionRequired={sessionRequired}
          onAuthenticate={authenticateOwner}
          day={selectedDayData}
          saveStateOf={saveStateOf}
          onCountChange={handleCountChange}
          onCountRetry={handleCountRetry}
        />
      </div>
    </div>
  ) : null;

  return (
    <main className="mx-auto max-w-5xl px-5 py-5">
      <div className="space-y-4">
        {mirror ? (
          <MirrorNotice
            publishedAt={mirror.publishedAt}
            captureHealth={mirror.captureHealth}
            captureFreshness={mirror.captureFreshness}
            liveUrl={mirror.liveUrl}
          />
        ) : null}
        <CodePulse selectedDay={data.today} />
        {summaryWeek ? (
          <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                  Week of {summaryWeek.label}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  <Num animate={false}>{String(data.totals.activeDays)}</Num>{" "}
                  active days ·{" "}
                  <Num animate={false}>
                    {String(data.totals.activeDayStreak)}
                  </Num>{" "}
                  day streak
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/20 px-3 py-1.5">
                <span className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                  Activity score
                </span>
                <Num className="text-lg font-semibold text-zinc-50">
                  {String(summaryWeek.weeklyValue)}
                </Num>
              </div>
            </div>
            <div className={cn("grid gap-3", summaryStats.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
              {summaryStats.map((stat) => (
                <div key={stat.label}>
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-[11px] uppercase tracking-[0.1em] text-zinc-500">
                      {stat.label}
                    </span>
                  </div>
                  <div className="mt-1 flex items-end gap-1">
                    <Num className="text-2xl font-semibold leading-none text-zinc-50">
                      {Number.isInteger(stat.value)
                        ? String(stat.value)
                        : stat.value.toFixed(1)}
                    </Num>
                    <span className="pb-0.5 text-xs text-zinc-500">
                      / {stat.target}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <motion.div
                      className={cn(
                        "h-full origin-left rounded-full bg-gradient-to-r",
                        stat.accent,
                      )}
                      initial={reduceMotion || !intro ? false : { scaleX: 0 }}
                      animate={{ scaleX: stat.pct }}
                      transition={motionTransition(reduceMotion, appSpring)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-zinc-400">
              Outreach paced Monday to Friday ·{" "}
              <span className="text-zinc-200">{summaryWeek.commits}</span>{" "}
              commits ·{" "}
              <span className="text-zinc-200">{summaryWeek.merges}</span> merges
            </p>
          </section>
        ) : null}
        <OutreachPipeline funnel={view.funnel} />
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
            <h2 className="text-sm font-semibold text-zinc-100">Activity trend</h2>
            <LayoutGroup id="ledger-trend-toggle">
              <div className="flex items-center gap-1 rounded-full bg-black/20 p-0.5">
                {(["daily", "weekly"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setChartMode(mode)}
                    aria-pressed={chartMode === mode}
                    className={cn(
                      "relative min-h-10 rounded-full px-3 text-xs capitalize transition-[color,scale] duration-150 ease-out active:scale-[0.96]",
                      chartMode === mode
                        ? "text-black"
                        : "text-zinc-400 hover:text-zinc-200",
                    )}
                  >
                    {chartMode === mode ? (
                      <motion.span
                        layoutId={
                          reduceMotion ? undefined : "ledger-trend-pill"
                        }
                        className="absolute inset-0 rounded-full bg-white"
                        transition={motionTransition(reduceMotion, appQuick)}
                      />
                    ) : null}
                    <span className="relative z-10">{mode}</span>
                  </button>
                ))}
              </div>
            </LayoutGroup>
          </div>
          <LedgerCharts
            mode={chartMode}
            dailyRows={view.dailyChart}
            weeklyRows={weeklyRows}
            selectedDay={trayOpen ? selectedDay : null}
            reduceMotion={reduceMotion}
            intro={intro}
          />
        </section>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-100">
            Weekday activity averages
          </h2>
          <div className="grid grid-cols-7 gap-2">
            {view.weekdayAverages.map((average, index) => (
              <div
                key={average.weekday}
                className="flex flex-col items-center gap-2"
              >
                <div className="relative h-24 w-full overflow-hidden rounded-xl bg-white/[0.04]">
                  <motion.div
                    className="absolute inset-x-0 bottom-0 rounded-t-[10px] bg-gradient-to-t from-cyan-300/95 via-teal-300/85 to-indigo-400/55"
                    initial={reduceMotion || !intro ? false : { height: 0 }}
                    animate={{
                      height: `${Math.max(3, average.averageValue)}%`,
                    }}
                    transition={motionTransition(reduceMotion, {
                      ...appSpring,
                      delay: intro ? index * 0.04 : 0,
                    })}
                  />
                </div>
                <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-500">
                  {average.weekday}
                </div>
                <div className="text-sm font-medium text-zinc-100">
                  <Num>{String(average.averageValue)}</Num>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">Activity history</h2>
            <p className="text-[11px] text-zinc-500">
              Tap a day to log it.
            </p>
          </div>
          <div className="grid grid-cols-[28px_repeat(7,minmax(0,1fr))] gap-1">
            <div />
            {WEEKDAY_COLUMNS.map((weekday) => (
              <div
                key={weekday}
                className="pb-1 text-center text-[10px] uppercase tracking-[0.08em] text-zinc-500"
              >
                {weekday}
              </div>
            ))}
            {viewWeeks.map((week, weekIndex) => {
              const railMonth = week.days[0].monthKey;
              const prevRailMonth =
                weekIndex > 0
                  ? viewWeeks[weekIndex - 1].days[0].monthKey
                  : null;
              const showRail = railMonth !== prevRailMonth;
              return (
                <Fragment key={week.weekStart}>
                  <div className="flex items-center justify-end pr-1 text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
                    {showRail ? week.days[0].monthLabel : ""}
                  </div>
                  {week.days.map((day, columnIndex) => {
                    const isSelected = day.day === selectedDay && trayOpen;
                    const isToday = day.day === data.today;
                    const aboveMonth =
                      weekIndex > 0
                        ? viewWeeks[weekIndex - 1].days[columnIndex]?.monthKey
                        : undefined;
                    const belowMonth =
                      weekIndex < viewWeeks.length - 1
                        ? viewWeeks[weekIndex + 1].days[columnIndex]?.monthKey
                        : undefined;
                    const leftMonth =
                      columnIndex > 0
                        ? week.days[columnIndex - 1].monthKey
                        : undefined;
                    const rightMonth =
                      columnIndex < 6
                        ? week.days[columnIndex + 1].monthKey
                        : undefined;
                    const monthTop =
                      day.inRange &&
                      aboveMonth !== undefined &&
                      aboveMonth !== day.monthKey;
                    const monthBottom =
                      day.inRange &&
                      belowMonth !== undefined &&
                      belowMonth !== day.monthKey;
                    const monthLeft =
                      day.inRange &&
                      leftMonth !== undefined &&
                      leftMonth !== day.monthKey;
                    const monthRight =
                      day.inRange &&
                      rightMonth !== undefined &&
                      rightMonth !== day.monthKey;
                    const valueFace = (
                      <div className="flex h-full flex-col justify-between p-1.5">
                        <div className="flex items-start justify-between">
                          <span className="text-[9px] font-medium text-zinc-400">
                            {day.inRange ? day.dayOfMonth : ""}
                          </span>
                        </div>
                        {day.inRange ? (
                          <Num className="self-end text-base font-semibold leading-none">
                            {String(day.dailyValue)}
                          </Num>
                        ) : null}
                      </div>
                    );

                    return (
                      <motion.button
                        key={day.day}
                        type="button"
                        disabled={!day.inRange}
                        aria-label={
                          day.inRange ? ledgerDayAriaLabel(day) : undefined
                        }
                        aria-pressed={isSelected}
                        onClick={() =>
                          day.inRange && beginDaySelection(day.day)
                        }
                        whileTap={
                          reduceMotion || !day.inRange
                            ? undefined
                            : { scale: 0.96 }
                        }
                        transition={motionTransition(reduceMotion, pressSpring)}
                        className={cn(
                          "relative h-14 rounded-[10px] border border-white/[0.04] [perspective:700px] transition-colors",
                          dayTone(day),
                          day.inRange
                            ? "cursor-pointer hover:border-white/20"
                            : "cursor-default",
                          monthTop && "!border-t-2 !border-t-white/55",
                          monthBottom && "!border-b-2 !border-b-white/55",
                          monthLeft && "!border-l-2 !border-l-white/55",
                          monthRight && "!border-r-2 !border-r-white/55",
                          isSelected && "ring-2 ring-white/90",
                          isToday && !isSelected && "ring-1 ring-cyan-400/60",
                        )}
                      >
                        <div className="absolute inset-0 overflow-hidden rounded-[10px]">
                          {valueFace}
                        </div>
                        {breatheDay === day.day ? (
                          <motion.span
                            initial={
                              reduceMotion
                                ? false
                                : { opacity: 0.6, scale: 0.96 }
                            }
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

      </div>

      <Sheet
        open={trayOpen && Boolean(selectedDayData)}
        onOpenChange={setTrayOpen}
      >
        {dayReportPanel ? (
          <SheetContent
            side={isWide ? "right" : "bottom"}
            showCloseButton={false}
            className={cn(
              "border-white/[0.08] bg-zinc-950/96 p-0 text-zinc-100 backdrop-blur-xl",
              isWide
                ? "w-full sm:max-w-[440px]"
                : "h-[min(76vh,620px)] w-full rounded-t-[28px] rounded-b-none",
            )}
          >
            <motion.div
              initial={
                reduceMotion
                  ? false
                  : isWide
                    ? { opacity: 0, x: 24 }
                    : { opacity: 0, y: 24 }
              }
              animate={{ opacity: 1, x: 0, y: 0 }}
              transition={motionTransition(reduceMotion, traySpring)}
              className="h-full min-h-0"
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
