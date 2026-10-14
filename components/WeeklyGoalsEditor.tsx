"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EMAIL_BONUS_MAX_POINTS,
  EMAIL_BONUS_POINTS_PER_EMAIL,
  type WeeklyTargets,
} from "@/lib/ledger";
import {
  validateWeeklyGoal,
  WEEKLY_GOAL_MAX_COUNT,
  WEEKLY_GOAL_MAX_HOURS,
  WEEKLY_GOAL_MIN_HOURS,
} from "@/lib/weekly-goal";
import { cn } from "@/lib/utils";
import { LedgerOwnerAccess } from "@/components/LedgerOwnerAccess";

export type WeeklyGoalOption = {
  weekStart: string;
  label: string;
  goal: WeeklyTargets;
};

type WeeklyGoalsEditorProps = {
  weeks: WeeklyGoalOption[];
  initialWeekStart: string;
  sessionRequired: boolean;
  onSave: (
    weekStart: string,
    connectionRequests: number,
    hours: number,
  ) => Promise<void>;

  onAuthenticate: (secret: string) => Promise<void>;
};
function goalValidationMessage(error: string): string {
  if (error.startsWith("weekStart")) {
    return "Choose a valid Monday.";
  }
  if (error.startsWith("weeklyConnectionRequests")) {
    return `Connection requests must be a whole number from 1 to ${WEEKLY_GOAL_MAX_COUNT.toLocaleString()}.`;
  }
  return `Hours must be from ${WEEKLY_GOAL_MIN_HOURS} to ${WEEKLY_GOAL_MAX_HOURS}.`;
}

/**
 * Edits the effective-dated connection-request and hours goals for one
 * displayed week. Emails are bonus, never a goal. A week still on an older
 * goal says so: one touches number opens with the requests field empty; an
 * email-and-requests goal opens with its requests, and saving drops the email
 * number.
 * Preconditions: `weeks` contains only selectable Monday-start weeks and the
 * callbacks persist through the server. Postcondition: a successful save leaves
 * the selected week showing the submitted goals after the next refresh.
 */
export function WeeklyGoalsEditor({
  weeks,
  initialWeekStart,
  sessionRequired,
  onSave,
  onAuthenticate,
}: WeeklyGoalsEditorProps) {
  const [selectedWeekStart, setSelectedWeekStart] = useState(initialWeekStart);
  const [requestsDraft, setRequestsDraft] = useState("");
  const [hoursDraft, setHoursDraft] = useState("");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveMessage, setSaveMessage] = useState("");

  const selectedWeek =
    weeks.find((week) => week.weekStart === selectedWeekStart) ??
    weeks[weeks.length - 1] ??
    null;
  const selectedWeekKey = selectedWeek?.weekStart ?? null;
  const outreach = selectedWeek?.goal.outreach ?? null;
  const olderGoal =
    outreach?.kind === "touches"
      ? `one goal of ${outreach.touches} touches`
      : outreach && outreach.emails > 0
        ? `${outreach.emails} emails and ${outreach.connectionRequests} connection requests`
        : null;
  const savedRequests =
    outreach?.kind === "channels" ? String(outreach.connectionRequests) : "";
  const selectedWeekHoursTarget = selectedWeek?.goal.hours ?? null;

  useEffect(() => {
    if (selectedWeekKey === null || selectedWeekHoursTarget === null) {
      return;
    }
    if (selectedWeekKey !== selectedWeekStart) {
      setSelectedWeekStart(selectedWeekKey);
    }
    setRequestsDraft(savedRequests);
    setHoursDraft(String(selectedWeekHoursTarget));
  }, [
    savedRequests,
    selectedWeekHoursTarget,
    selectedWeekKey,
    selectedWeekStart,
  ]);

  const draftRequests = Number(requestsDraft || 0);

  useEffect(() => {
    setSaveState("idle");
    setSaveMessage("");
  }, [selectedWeekKey]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWeek) {
      return;
    }
    const connectionRequests =
      requestsDraft === "" ? Number.NaN : Number(requestsDraft);
    const hours = Number(hoursDraft);
    const validation = validateWeeklyGoal(
      selectedWeek.weekStart,
      connectionRequests,
      hours,
    );
    if (!validation.ok) {
      setSaveState("error");
      setSaveMessage(goalValidationMessage(validation.error));
      return;
    }

    setSaveState("saving");
    setSaveMessage("");
    try {
      await onSave(selectedWeek.weekStart, connectionRequests, hours);
      setSaveState("saved");
      setSaveMessage("Goals saved for this week.");
    } catch (error) {
      setSaveState("error");
      setSaveMessage(
        error instanceof Error && error.message === "AUTH_REQUIRED"
          ? "Unlock editing below, then save again."
          : "Could not save these goals.",
      );
    }
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.2)] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Weekly goals</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-500">
            Set the expectation for each week. Earlier weeks keep the goal they
            were measured against.
          </p>
        </div>
        <span className="rounded-md border border-white/[0.08] bg-black/20 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
          Effective from Monday
        </span>
      </div>

      {selectedWeek ? (
        <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
          <label className="block text-xs text-zinc-400">
            Week to edit
            <select
              aria-label="Week to edit"
              className="mt-1 h-9 w-full rounded-md border border-white/[0.1] bg-black/30 px-3 text-sm text-zinc-100 outline-none transition-colors focus:border-white/30 focus:ring-2 focus:ring-white/10"
              value={selectedWeek.weekStart}
              onChange={(event) => setSelectedWeekStart(event.target.value)}
            >
              {weeks.map((week) => (
                <option key={week.weekStart} value={week.weekStart}>
                  Week of {week.label}
                </option>
              ))}
            </select>
          </label>

          {olderGoal !== null ? (
            <p className="text-xs leading-5 text-zinc-400">
              This week uses an older goal of {olderGoal}. Saving replaces it
              with a connection-request goal; emails become bonus.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Connection requests / week
              <Input
                aria-label="Connection requests per week"
                className="mt-1 border-white/[0.1] bg-black/30 text-zinc-100"
                type="number"
                min={1}
                max={WEEKLY_GOAL_MAX_COUNT}
                step={1}
                placeholder="e.g. 250"
                value={requestsDraft}
                onChange={(event) => setRequestsDraft(event.target.value)}
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Hours / week
              <Input
                aria-label="Hours per week"
                className="mt-1 border-white/[0.1] bg-black/30 text-zinc-100"
                type="number"
                min={WEEKLY_GOAL_MIN_HOURS}
                max={WEEKLY_GOAL_MAX_HOURS}
                step="any"
                value={hoursDraft}
                onChange={(event) => setHoursDraft(event.target.value)}
              />
            </label>
          </div>
          <p className="text-[11px] text-zinc-500" aria-live="polite">
            {Number.isFinite(draftRequests) && draftRequests > 0
              ? `${draftRequests} requests a week, paced Monday to Friday.`
              : "Paced Monday to Friday. Weekends carry no outreach goal."}{" "}
            Emails are bonus: +{EMAIL_BONUS_POINTS_PER_EMAIL} point each on the week, up to +
            {EMAIL_BONUS_MAX_POINTS}.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={saveState === "saving"}>
              {saveState === "saving" ? "Saving…" : "Save goals"}
            </Button>
            <p
              className={cn(
                "text-xs",
                saveState === "error"
                  ? "text-rose-300"
                  : saveState === "saved"
                    ? "text-emerald-300"
                    : "text-zinc-500",
              )}
              role="status"
              aria-live="polite"
            >
              {saveMessage ||
                "Changes apply from the selected week forward until the next saved week."}
            </p>
          </div>
        </form>
      ) : null}

      {sessionRequired ? (
        <div className="mt-4">
          <LedgerOwnerAccess onAuthenticate={onAuthenticate} />
        </div>
      ) : null}
    </section>
  );
}
