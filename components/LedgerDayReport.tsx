"use client";

import { NumberField } from "@heroui/react";
import { Check, Minus, Plus, RotateCcw, Sparkles } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Num } from "@/components/Num";
import { appQuick, appSpring, motionTransition, pressSpring } from "@/components/MotionPrimitives";
import type { LedgerDay } from "@/lib/ledger";
import { progressState, statusTone } from "@/lib/ledger-ui";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "saving" | "error";

export type LedgerDayReportProps = {
  day: LedgerDay;
  reachouts: number;
  onReachoutsChange: (value: number) => void;
  onReachoutsRetry: () => void;
  reachoutsState: SaveState;
  replies: number;
  onRepliesChange: (value: number) => void;
  onRepliesRetry: () => void;
  repliesState: SaveState;
  meetings: number;
  onMeetingsChange: (value: number) => void;
  onMeetingsRetry: () => void;
  meetingsState: SaveState;
  featureDone: boolean;
  onFeatureDoneChange: (value: boolean) => void;
  onFeatureRetry: () => void;
  featureState: SaveState;
  dailyReachoutTarget: number;
  dailyHoursTarget: number;
};

const QUICK_ADJUSTMENTS = [5, 10, 25] as const;

function saveMessage(state: SaveState, idleText: string): string {
  if (state === "saving") {
    return "Saving…";
  }
  if (state === "error") {
    return "Could not save.";
  }
  return idleText;
}

// A targetless count input (replies, meetings booked): number, stepper, and the
// same debounced-save/inline-retry affordance as reachouts, minus the daily
// target/progress bar those metrics don't have (they're judged by weekly rate).
function CountField({
  label,
  ariaLabel,
  value,
  onChange,
  onRetry,
  saveState
}: {
  label: string;
  ariaLabel: string;
  value: number;
  onChange: (value: number) => void;
  onRetry: () => void;
  saveState: SaveState;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <Num className="text-3xl font-semibold leading-none text-zinc-50">{String(value)}</Num>
        <NumberField.Root
          aria-label={ariaLabel}
          value={value}
          minValue={0}
          maxValue={1000}
          step={1}
          formatOptions={{ useGrouping: false }}
          onChange={(next) => onChange(Number.isNaN(next) ? 0 : next)}
        >
          <NumberField.Group className="flex h-10 items-center rounded-full border border-white/[0.08] bg-black/20 px-1">
            <NumberField.DecrementButton
              aria-label={`Decrease ${ariaLabel}`}
              className="inline-flex size-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 active:scale-[0.96]"
            >
              <Minus className="size-4" />
            </NumberField.DecrementButton>
            <NumberField.Input className="h-10 w-12 bg-transparent text-center text-base font-semibold text-zinc-50 outline-none" />
            <NumberField.IncrementButton
              aria-label={`Increase ${ariaLabel}`}
              className="inline-flex size-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 active:scale-[0.96]"
            >
              <Plus className="size-4" />
            </NumberField.IncrementButton>
          </NumberField.Group>
        </NumberField.Root>
      </div>
      <div className="mt-2 flex min-h-4 items-center gap-2 text-[11px] text-zinc-500" aria-live="polite">
        <span>{saveMessage(saveState, "")}</span>
        {saveState === "error" ? (
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-zinc-200 transition-colors hover:text-white">
            <RotateCcw className="size-3" />
            Retry
          </button>
        ) : null}
      </div>
    </section>
  );
}

// One day's report surface: debounced logging, optimistic status, and inline retry
// states instead of silent failure.
export function LedgerDayReport({
  day,
  reachouts,
  onReachoutsChange,
  onReachoutsRetry,
  reachoutsState,
  replies,
  onRepliesChange,
  onRepliesRetry,
  repliesState,
  meetings,
  onMeetingsChange,
  onMeetingsRetry,
  meetingsState,
  featureDone,
  onFeatureDoneChange,
  onFeatureRetry,
  featureState,
  dailyReachoutTarget,
  dailyHoursTarget
}: LedgerDayReportProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const reachoutWidth = `${Math.min(100, (reachouts / dailyReachoutTarget) * 100)}%`;
  const hoursWidth = `${Math.min(100, (day.hours / dailyHoursTarget) * 100)}%`;
  const reachoutState = progressState(reachouts, dailyReachoutTarget);
  const hoursState = progressState(day.hours, dailyHoursTarget);
  const featureText = featureDone ? "Feature shipped" : "Not shipped yet";

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">Reachouts</p>
          <span className={cn("text-xs font-medium capitalize", statusTone(reachoutState))}>{reachoutState}</span>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div className="flex items-end gap-2">
            <Num className="text-3xl font-semibold leading-none text-zinc-50">{String(reachouts)}</Num>
            <span className="pb-0.5 text-sm text-zinc-500">/ {Math.round(dailyReachoutTarget)}</span>
          </div>
          <NumberField.Root
            aria-label="Daily reachouts"
            value={reachouts}
            minValue={0}
            maxValue={1000}
            step={1}
            formatOptions={{ useGrouping: false }}
            onChange={(value) => onReachoutsChange(Number.isNaN(value) ? 0 : value)}
          >
            <NumberField.Group className="flex h-10 items-center rounded-full border border-white/[0.08] bg-black/20 px-1">
              <NumberField.DecrementButton
                aria-label="Decrease reachouts"
                className="inline-flex size-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 active:scale-[0.96]"
              >
                <Minus className="size-4" />
              </NumberField.DecrementButton>
              <NumberField.Input className="h-10 w-12 bg-transparent text-center text-base font-semibold text-zinc-50 outline-none" />
              <NumberField.IncrementButton
                aria-label="Increase reachouts"
                className="inline-flex size-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 active:scale-[0.96]"
              >
                <Plus className="size-4" />
              </NumberField.IncrementButton>
            </NumberField.Group>
          </NumberField.Root>
        </div>
        <div className="mt-3 flex gap-1.5">
          {QUICK_ADJUSTMENTS.map((step) => (
            <button
              key={step}
              type="button"
              onClick={() => onReachoutsChange(reachouts + step)}
              className="inline-flex h-8 flex-1 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.14] hover:text-zinc-100 active:scale-[0.96]"
            >
              +{step}
            </button>
          ))}
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
          <motion.div
            animate={{ width: reachoutWidth }}
            initial={reduceMotion ? false : { width: 0 }}
            transition={motionTransition(reduceMotion, appSpring)}
            className="h-full rounded-full bg-[linear-gradient(90deg,rgba(94,234,212,0.7),rgba(59,130,246,0.95))]"
          />
        </div>
        <div className="mt-2 flex min-h-4 items-center gap-2 text-[11px] text-zinc-500" aria-live="polite">
          <span>{saveMessage(reachoutsState, `Target ${Math.round(dailyReachoutTarget)}`)}</span>
          {reachoutsState === "error" ? (
            <button type="button" onClick={onReachoutsRetry} className="inline-flex items-center gap-1 text-zinc-200 transition-colors hover:text-white">
              <RotateCcw className="size-3" />
              Retry
            </button>
          ) : null}
        </div>
      </section>

      <CountField
        label="Replies"
        ariaLabel="daily replies"
        value={replies}
        onChange={onRepliesChange}
        onRetry={onRepliesRetry}
        saveState={repliesState}
      />

      <CountField
        label="Meetings booked"
        ariaLabel="daily meetings booked"
        value={meetings}
        onChange={onMeetingsChange}
        onRetry={onMeetingsRetry}
        saveState={meetingsState}
      />

      <p className="px-1 text-[11px] text-zinc-500" aria-label="Cortal build activity today">
        Cortal today: <span className="text-zinc-300">{day.commits}</span> commits · <span className="text-zinc-300">{day.merges}</span> merges
      </p>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">Hours</p>
          <span className={cn("text-xs font-medium capitalize", statusTone(hoursState))}>{hoursState}</span>
        </div>
        <div className="mt-2 flex items-end gap-2">
          <Num className="text-2xl font-semibold leading-none text-zinc-50">{day.hours.toFixed(1)}</Num>
          <span className="pb-0.5 text-sm text-zinc-500">/ {dailyHoursTarget.toFixed(1)} · auto from Tally</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
          <motion.div
            animate={{ width: hoursWidth }}
            initial={reduceMotion ? false : { width: 0 }}
            transition={motionTransition(reduceMotion, appSpring)}
            className="h-full rounded-full bg-[linear-gradient(90deg,rgba(99,102,241,0.7),rgba(56,189,248,0.95))]"
          />
        </div>
      </section>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">Feature day</p>
            <p className="mt-1 text-xs text-zinc-500">Shipped something end-to-end?</p>
          </div>
          <motion.button
            type="button"
            aria-pressed={featureDone}
            onClick={() => onFeatureDoneChange(!featureDone)}
            whileTap={reduceMotion ? undefined : { scale: 0.96 }}
            transition={motionTransition(reduceMotion, pressSpring)}
            className={cn(
              "relative inline-flex h-10 min-w-[140px] items-center justify-center overflow-hidden rounded-full border px-4 text-sm font-medium transition-colors",
              featureDone
                ? "border-emerald-300/30 bg-emerald-400/12 text-emerald-100"
                : "border-white/[0.08] bg-black/20 text-zinc-300 hover:border-white/[0.14] hover:text-zinc-100"
            )}
          >
            <span className="relative z-10 inline-flex items-center gap-2">
              <AnimatePresence initial={false} mode="popLayout">
                {featureDone ? (
                  <motion.span
                    key="feature-done"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.25, rotate: -90, filter: "blur(4px)" }}
                    animate={{ opacity: 1, scale: 1, rotate: 0, filter: "blur(0px)" }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.25, rotate: 90, filter: "blur(4px)" }}
                    transition={motionTransition(reduceMotion, appSpring)}
                    className="inline-flex items-center gap-2"
                  >
                    <Sparkles className="size-4" aria-hidden />
                    {featureText}
                  </motion.span>
                ) : (
                  <motion.span
                    key="feature-pending"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                    transition={motionTransition(reduceMotion, appQuick)}
                    className="inline-flex items-center gap-2"
                  >
                    <span className="size-2 rounded-full bg-zinc-500" aria-hidden />
                    {featureText}
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </motion.button>
        </div>
        {featureState !== "idle" ? (
          <div className="mt-2 flex min-h-4 items-center gap-2 text-[11px] text-zinc-500" aria-live="polite">
            <span>{saveMessage(featureState, "")}</span>
            {featureState === "error" ? (
              <button type="button" onClick={onFeatureRetry} className="inline-flex items-center gap-1 text-zinc-200 transition-colors hover:text-white">
                <RotateCcw className="size-3" />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
