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
import {
  AWAY_HOURS_CREDIT,
  EMAIL_BONUS_MAX_POINTS,
  type LedgerDay,
} from "@/lib/ledger";
import { progressState, statusTone, type ProgressState } from "@/lib/ledger-ui";
import { outreachTally } from "@/lib/outreach-pace";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "saving" | "error";

export type LedgerDayReportProps = {
  sessionRequired: boolean;
  onAuthenticate: (secret: string) => Promise<void>;
  /** The selected day with unsaved drafts already applied and re-scored. */
  day: LedgerDay;
  /**
   * Bonus points the day's week has from emails so far, or null when that
   * week's goal counts emails (weeks saved before Oct 13, 2026).
   */
  emailBonus: number | null;
  saveStateOf: (field: ManualCountField) => SaveState;
  onCountChange: (field: ManualCountField, value: number) => void;
  onCountRetry: (field: ManualCountField) => void;
};

const QUICK_ADJUSTMENTS = [5, 10, 25] as const;

// Away time is stored in minutes and entered in half hours, up to the whole
// hours the stored count allows.
const AWAY_STEP_HOURS = 0.5;
const AWAY_MAX_HOURS = Math.floor(MAX_DAILY_COUNT / 60);

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
  /** The count is stored in minutes but entered in half hours. */
  inHours?: boolean;
} & Pick<
  LedgerDayReportProps,
  "saveStateOf" | "onCountChange" | "onCountRetry"
>;

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
  inHours,
  saveStateOf,
  onCountChange,
  onCountRetry,
}: RowProps) {
  const saveState = saveStateOf(field);
  const shown = inHours ? value / 60 : value;
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
            aria-label={`${label} on this day${inHours ? ", in hours" : ""}`}
            value={shown}
            minValue={0}
            maxValue={inHours ? AWAY_MAX_HOURS : MAX_DAILY_COUNT}
            step={inHours ? AWAY_STEP_HOURS : 1}
            formatOptions={
              inHours
                ? { useGrouping: false, maximumFractionDigits: 1 }
                : { useGrouping: false }
            }
            onChange={(next) => {
              const entered = Number.isNaN(next) ? 0 : next;
              onCountChange(
                field,
                // Snap to the half-hour grid so stored minutes and the shown
                // hours never drift apart.
                inHours
                  ? Math.round(entered / AWAY_STEP_HOURS) * AWAY_STEP_HOURS * 60
                  : entered,
              );
            }}
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

// Answers and first messages owed count toward the day's goals, so the row
// says so.
function owedDetail(
  value: number,
  due: number | undefined,
  verb: "answer" | "message",
): { detail?: string; detailState?: ProgressState } {
  if (due === undefined) return {};
  if (due === 0) return { detail: `Everyone ${verb}ed` };
  return {
    detail: `${Math.min(value, due)} of ${due} to ${verb} · counts toward goals`,
    detailState: progressState(value, due),
  };
}

// Where the day's hours come from: the desk (captures) and, when logged,
// away time at its discount.
function hoursSource(day: LedgerDay): string {
  const desk = `${day.hours.toFixed(1)} h at desk`;
  if (day.awayMinutes === 0) {
    return `${desk} · auto from Tally`;
  }
  const away = (day.awayMinutes / 60).toFixed(1);
  const counted = (day.creditedHours - day.hours).toFixed(1);
  return `${desk} + ${away} h away (counts ${counted} h)`;
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
  emailBonus,
  saveStateOf,
  onCountChange,
  onCountRetry,
}: LedgerDayReportProps) {
  const rowProps = { saveStateOf, onCountChange, onCountRetry };
  const bar = day.targets?.outreach ?? null;
  const hoursTarget = day.targets?.hours ?? null;
  const channelBars = bar?.kind === "channels" ? bar : null;
  const touchesBar = bar?.kind === "touches" ? bar : null;
  const touchesToday = outreachTally(day).touches;
  const unsplitFields = UNSPLIT_COUNT_FIELDS.filter((field) => day[field] > 0);
  const hoursState =
    hoursTarget === null ? null : progressState(day.creditedHours, hoursTarget);

  return (
    <div className="space-y-3">
      {sessionRequired ? (
        <LedgerOwnerAccess onAuthenticate={onAuthenticate} />
      ) : null}
      {bar === null ? (
        <p className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-xs leading-5 text-zinc-400">
          Weekend: no goals. Hours, follow-ups, and anything else you log count
          toward the week as extra work.
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
          {...(emailBonus !== null
            ? {
                detail: `Bonus · +${emailBonus} of ${EMAIL_BONUS_MAX_POINTS} on the week`,
              }
            : channelBars
              ? {
                  quickAdd: true,
                  goal: channelBars.emails,
                  ...goalDetail(day.emailsSent, channelBars.emails),
                }
              : { quickAdd: true })}
          {...rowProps}
        />
        <CountRow
          field="emailFollowUps"
          label="Follow-ups"
          value={day.emailFollowUps}
          {...dueDetail(
            day.emailFollowUps,
            day.due?.emailFollowUps,
            "emails 3+ weekdays old",
          )}
          {...rowProps}
        />
        <CountRow
          field="emailReplies"
          label="Replies received"
          value={day.emailReplies}
          {...rowProps}
        />
        <CountRow
          field="emailRepliesAnswered"
          label="Replies answered"
          value={day.emailRepliesAnswered}
          {...owedDetail(
            day.emailRepliesAnswered,
            day.due?.emailRepliesAnswered,
            "answer",
          )}
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
          {...owedDetail(
            day.linkedinMessages,
            day.due?.linkedinMessages,
            "message",
          )}
          {...rowProps}
        />
        <CountRow
          field="linkedinReplies"
          label="Replies received"
          value={day.linkedinReplies}
          {...rowProps}
        />
        <CountRow
          field="linkedinRepliesAnswered"
          label="Replies answered"
          value={day.linkedinRepliesAnswered}
          {...owedDetail(
            day.linkedinRepliesAnswered,
            day.due?.linkedinRepliesAnswered,
            "answer",
          )}
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
          {hoursState ? (
            <span
              className={cn(
                "text-xs font-medium capitalize",
                statusTone(hoursState),
              )}
            >
              {hoursState}
            </span>
          ) : (
            <span className="text-xs text-zinc-500">Extra</span>
          )}
        </div>
        <div className="mt-2 flex items-end gap-2">
          <Num className="text-2xl font-semibold leading-none text-zinc-50">
            {day.creditedHours.toFixed(1)}
          </Num>
          <span className="pb-0.5 text-sm text-zinc-500">
            {hoursTarget === null
              ? "no goal on weekends"
              : `/ ${hoursTarget.toFixed(1)}`}
          </span>
        </div>
        <p className="mt-1 text-[11px] tabular-nums text-zinc-500">
          {hoursSource(day)}
        </p>
        {hoursTarget !== null ? (
          <div className="mt-2">
            <Bar
              value={day.creditedHours}
              target={hoursTarget}
              gradient={HOURS_GRADIENT}
            />
          </div>
        ) : null}
        <div className="mt-3 border-t border-white/[0.05] pt-1">
          <CountRow
            field="awayMinutes"
            label="Away from desk"
            value={day.awayMinutes}
            detail={`Hours the camera can't see · count at ${AWAY_HOURS_CREDIT * 100}%`}
            inHours
            {...rowProps}
          />
        </div>
      </section>
    </div>
  );
}
