"use client";

import { NumberField } from "@heroui/react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Num } from "@/components/Num";
import { LedgerOwnerAccess } from "@/components/LedgerOwnerAccess";
import { appSpring, motionTransition } from "@/components/MotionPrimitives";
import {
  MAX_DAILY_COUNT,
  UNSPLIT_COUNT_FIELDS,
  type ManualCountField,
} from "@/lib/ledger-fields";
import type { LedgerDay } from "@/lib/ledger";
import { progressState, statusTone, type ProgressState } from "@/lib/ledger-ui";
import { outreachDone, outreachTally } from "@/lib/outreach-pace";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "saving" | "error";

export type LedgerDayReportProps = {
  sessionRequired: boolean;
  onAuthenticate: (secret: string) => Promise<void>;
  /** The selected day with unsaved drafts already applied and re-scored. */
  day: LedgerDay;
  saveStateOf: (field: ManualCountField) => SaveState;
  onCountChange: (field: ManualCountField, value: number) => void;
  onCountRetry: (field: ManualCountField) => void;
};

const QUICK_ADJUSTMENTS = [5, 10, 25] as const;

const UNSPLIT_LABELS: Record<(typeof UNSPLIT_COUNT_FIELDS)[number], string> = {
  reachouts: "Touches",
  replies: "Replies",
  meetings: "Meetings",
  followUpsSent: "Follow-ups",
};

function Bar({
  value,
  target,
  gradient,
}: {
  value: number;
  target: number;
  gradient: string;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const width =
    target > 0 ? `${Math.min(100, (value / target) * 100)}%` : "100%";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
      <motion.div
        animate={{ width }}
        initial={reduceMotion ? false : { width: 0 }}
        transition={motionTransition(reduceMotion, appSpring)}
        className={cn("h-full rounded-full", gradient)}
      />
    </div>
  );
}

const OUTREACH_GRADIENT =
  "bg-[linear-gradient(90deg,rgba(94,234,212,0.7),rgba(59,130,246,0.95))]";
const HOURS_GRADIENT =
  "bg-[linear-gradient(90deg,rgba(99,102,241,0.7),rgba(56,189,248,0.95))]";

type RowProps = {
  field: ManualCountField;
  label: string;
  value: number;
  /** One quiet line under the label: a goal, a due count, or nothing. */
  detail?: string;
  detailState?: ProgressState;
  /** Renders a progress bar and quick-add buttons for the day's high-volume inputs. */
  goal?: number;
  quickAdd?: boolean;
} & Pick<LedgerDayReportProps, "saveStateOf" | "onCountChange" | "onCountRetry">;

// One loggable count: label and its context on the left, the stepper on the
// right. Saving and retry live on the row so a failure points at its field.
function CountRow({
  field,
  label,
  value,
  detail,
  detailState,
  goal,
  quickAdd,
  saveStateOf,
  onCountChange,
  onCountRetry,
}: RowProps) {
  const saveState = saveStateOf(field);
  return (
    <div className="py-3 first:pt-1 last:pb-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-zinc-100">{label}</p>
          <p
            className={cn(
              "mt-0.5 text-[11px]",
              detailState ? statusTone(detailState) : "text-zinc-500",
            )}
            aria-live="polite"
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "error"
                ? "Could not save."
                : (detail ?? " ")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {saveState === "error" ? (
            <button
              type="button"
              onClick={() => onCountRetry(field)}
              className="inline-flex min-h-10 items-center gap-1 px-2 text-[11px] text-zinc-200 transition-colors hover:text-white active:scale-[0.96]"
            >
              <RotateCcw className="size-3" />
              Retry
            </button>
          ) : null}
          <NumberField.Root
            aria-label={`${label} on this day`}
            value={value}
            minValue={0}
            maxValue={MAX_DAILY_COUNT}
            step={1}
            formatOptions={{ useGrouping: false }}
            onChange={(next) =>
              onCountChange(field, Number.isNaN(next) ? 0 : next)
            }
          >
            <NumberField.Group className="flex h-10 items-center rounded-xl border border-white/[0.08] bg-black/20 px-0.5">
              <NumberField.DecrementButton
                aria-label={`Decrease ${label.toLowerCase()}`}
                className="inline-flex size-9 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 active:scale-[0.96]"
              >
                <Minus className="size-4" />
              </NumberField.DecrementButton>
              <NumberField.Input className="h-9 w-11 bg-transparent text-center text-base font-semibold tabular-nums text-zinc-50 outline-none" />
              <NumberField.IncrementButton
                aria-label={`Increase ${label.toLowerCase()}`}
                className="inline-flex size-9 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 active:scale-[0.96]"
              >
                <Plus className="size-4" />
              </NumberField.IncrementButton>
            </NumberField.Group>
          </NumberField.Root>
        </div>
      </div>
      {goal !== undefined ? (
        <div className="mt-2.5">
          <Bar value={value} target={goal} gradient={OUTREACH_GRADIENT} />
        </div>
      ) : null}
      {quickAdd ? (
        <div className="mt-2.5 flex gap-1.5">
          {QUICK_ADJUSTMENTS.map((step) => (
            <button
              key={step}
              type="button"
              onClick={() => onCountChange(field, value + step)}
              aria-label={`Add ${step} to ${label.toLowerCase()}`}
              className="inline-flex h-9 flex-1 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.14] hover:text-zinc-100 active:scale-[0.96]"
            >
              +{step}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Card({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 pb-1 pt-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          {title}
        </h3>
        {aside ? (
          <span className="text-[11px] text-zinc-500">{aside}</span>
        ) : null}
      </div>
      <div className="mt-1 divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

function goalDetail(
  value: number,
  goal: number,
): { detail: string; detailState: ProgressState } {
  const state = progressState(value, goal);
  if (goal <= 0)
    return {
      detail: "Ahead of pace. Nothing required today.",
      detailState: "done",
    };
  return { detail: `${value} of ${goal} today · ${state}`, detailState: state };
}

function dueDetail(
  value: number,
  due: number | undefined,
  source: string,
): { detail?: string; detailState?: ProgressState } {
  if (due === undefined) return {};
  if (due === 0) return { detail: "Nothing due" };
  return {
    detail: `${Math.min(value, due)} of ${due} due · ${source}`,
    detailState: progressState(value, due),
  };
}

/**
 * One day's log, grouped the way outreach actually happens: Email, then
 * LinkedIn, each with its inputs first and outcomes after. Bars and due counts
 * come from the day's own catch-up targets; nothing here computes a goal.
 */
export function LedgerDayReport({
  sessionRequired,
  onAuthenticate,
  day,
  saveStateOf,
  onCountChange,
  onCountRetry,
}: LedgerDayReportProps) {
  const rowProps = { saveStateOf, onCountChange, onCountRetry };
  const bar = day.targets.outreach;
  const channelBars = bar?.kind === "channels" ? bar : null;
  const touchesBar = bar?.kind === "touches" ? bar : null;
  const touchesToday = bar ? outreachDone(outreachTally(day), bar) : 0;
  const unsplitFields = UNSPLIT_COUNT_FIELDS.filter((field) => day[field] > 0);
  const hoursState = progressState(day.hours, day.targets.hours);

  return (
    <div className="space-y-3">
      {sessionRequired ? <LedgerOwnerAccess onAuthenticate={onAuthenticate} /> : null}
      {bar === null ? (
        <p className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-xs leading-5 text-zinc-400">
          Weekend. There's no outreach goal today; anything you log still counts
          toward the week.
        </p>
      ) : null}

      {touchesBar ? (
        <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
              Touches today
            </p>
            <span
              className={cn(
                "text-xs font-medium capitalize",
                statusTone(progressState(touchesToday, touchesBar.touches)),
              )}
            >
              {touchesBar.touches <= 0
                ? "ahead"
                : progressState(touchesToday, touchesBar.touches)}
            </span>
          </div>
          <div className="mt-2 flex items-end gap-2">
            <Num className="text-3xl font-semibold leading-none text-zinc-50">
              {String(touchesToday)}
            </Num>
            <span className="pb-0.5 text-sm text-zinc-500">
              / {touchesBar.touches}
            </span>
          </div>
          <div className="mt-3">
            <Bar
              value={touchesToday}
              target={touchesBar.touches}
              gradient={OUTREACH_GRADIENT}
            />
          </div>
          <p className="mt-2 text-[11px] leading-4 text-zinc-500">
            Emails and connection requests below both count toward it.
          </p>
        </section>
      ) : null}

      <Card title="Email">
        <CountRow
          field="emailsSent"
          label="Sent"
          value={day.emailsSent}
          quickAdd
          {...(channelBars
            ? {
                goal: channelBars.emails,
                ...goalDetail(day.emailsSent, channelBars.emails),
              }
            : {})}
          {...rowProps}
        />
        <CountRow
          field="emailFollowUps"
          label="Follow-ups"
          value={day.emailFollowUps}
          {...dueDetail(
            day.emailFollowUps,
            day.due?.emailFollowUps,
            "sent 3 weekdays ago",
          )}
          {...rowProps}
        />
        <CountRow
          field="emailReplies"
          label="Replies"
          value={day.emailReplies}
          {...rowProps}
        />
        <CountRow
          field="emailMeetings"
          label="Meetings booked"
          value={day.emailMeetings}
          {...rowProps}
        />
      </Card>

      <Card title="LinkedIn">
        <CountRow
          field="connectionRequests"
          label="Connection requests"
          value={day.connectionRequests}
          quickAdd
          {...(channelBars
            ? {
                goal: channelBars.connectionRequests,
                ...goalDetail(
                  day.connectionRequests,
                  channelBars.connectionRequests,
                ),
              }
            : {})}
          {...rowProps}
        />
        <CountRow
          field="connections"
          label="Accepted"
          value={day.connections}
          {...rowProps}
        />
        <CountRow
          field="linkedinMessages"
          label="First messages"
          value={day.linkedinMessages}
          {...dueDetail(
            day.linkedinMessages,
            day.due?.linkedinMessages,
            "accepted, not yet messaged",
          )}
          {...rowProps}
        />
        <CountRow
          field="linkedinReplies"
          label="Replies"
          value={day.linkedinReplies}
          {...rowProps}
        />
        <CountRow
          field="linkedinMeetings"
          label="Meetings booked"
          value={day.linkedinMeetings}
          {...rowProps}
        />
      </Card>

      {unsplitFields.length > 0 ? (
        <Card title="Logged without a channel" aside="Kept as history">
          {unsplitFields.map((field) => (
            <CountRow
              key={field}
              field={field}
              label={UNSPLIT_LABELS[field]}
              value={day[field]}
              {...rowProps}
            />
          ))}
        </Card>
      ) : null}

      <p
        className="px-1 text-[11px] text-zinc-500"
        aria-label="Cortal build activity today"
      >
        Cortal today: <span className="text-zinc-300">{day.commits}</span>{" "}
        commits · <span className="text-zinc-300">{day.merges}</span> merges
      </p>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
            Hours
          </p>
          <span
            className={cn(
              "text-xs font-medium capitalize",
              statusTone(hoursState),
            )}
          >
            {hoursState}
          </span>
        </div>
        <div className="mt-2 flex items-end gap-2">
          <Num className="text-2xl font-semibold leading-none text-zinc-50">
            {day.hours.toFixed(1)}
          </Num>
          <span className="pb-0.5 text-sm text-zinc-500">
            / {day.targets.hours.toFixed(1)} · auto from Tally
          </span>
        </div>
        <div className="mt-2">
          <Bar
            value={day.hours}
            target={day.targets.hours}
            gradient={HOURS_GRADIENT}
          />
        </div>
      </section>
    </div>
  );
}
