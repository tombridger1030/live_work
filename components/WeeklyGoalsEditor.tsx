"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateWeeklyGoal, WEEKLY_GOAL_MAX_HOURS, WEEKLY_GOAL_MAX_REACHOUTS, WEEKLY_GOAL_MIN_HOURS, WEEKLY_GOAL_MIN_REACHOUTS } from "@/lib/weekly-goal";
import { cn } from "@/lib/utils";

export type WeeklyGoalOption = {
  weekStart: string;
  label: string;
  reachoutsTarget: number;
  hoursTarget: number;
};

type WeeklyGoalsEditorProps = {
  weeks: WeeklyGoalOption[];
  initialWeekStart: string;
  sessionRequired: boolean;
  onSave: (weekStart: string, reachouts: number, hours: number) => Promise<void>;

  onAuthenticate: (secret: string) => Promise<void>;
};
function goalValidationMessage(error: string): string {
  if (error.startsWith("weekStart")) {
    return "Choose a valid Monday.";
  }
  if (error.startsWith("weeklyReachouts")) {
    return `Messages must be a whole number from ${WEEKLY_GOAL_MIN_REACHOUTS.toLocaleString()} to ${WEEKLY_GOAL_MAX_REACHOUTS.toLocaleString()}.`;
  }
  return `Hours must be from ${WEEKLY_GOAL_MIN_HOURS} to ${WEEKLY_GOAL_MAX_HOURS}.`;
}

/**
 * Edits the effective-dated message and hours goals for one displayed week.
 * Preconditions: `weeks` contains only selectable Monday-start weeks and the
 * callbacks persist through the server. Postcondition: a successful save leaves
 * the selected week showing the submitted goals after the next refresh.
 */
export function WeeklyGoalsEditor({ weeks, initialWeekStart, sessionRequired, onSave, onAuthenticate }: WeeklyGoalsEditorProps) {
  const [selectedWeekStart, setSelectedWeekStart] = useState(initialWeekStart);
  const [messagesDraft, setMessagesDraft] = useState("");
  const [hoursDraft, setHoursDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [secretDraft, setSecretDraft] = useState("");
  const [authState, setAuthState] = useState<"idle" | "saving" | "error">("idle");

  const selectedWeek = weeks.find((week) => week.weekStart === selectedWeekStart) ?? weeks[weeks.length - 1] ?? null;
  const selectedWeekKey = selectedWeek?.weekStart ?? null;
  const selectedWeekReachoutsTarget = selectedWeek?.reachoutsTarget ?? null;
  const selectedWeekHoursTarget = selectedWeek?.hoursTarget ?? null;

  useEffect(() => {
    if (selectedWeekKey === null || selectedWeekReachoutsTarget === null || selectedWeekHoursTarget === null) {
      return;
    }
    if (selectedWeekKey !== selectedWeekStart) {
      setSelectedWeekStart(selectedWeekKey);
    }
    setMessagesDraft(String(selectedWeekReachoutsTarget));
    setHoursDraft(String(selectedWeekHoursTarget));
  }, [selectedWeekHoursTarget, selectedWeekKey, selectedWeekReachoutsTarget, selectedWeekStart]);

  useEffect(() => {
    setSaveState("idle");
    setSaveMessage("");
  }, [selectedWeekKey]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWeek) {
      return;
    }
    const reachouts = Number(messagesDraft);
    const hours = Number(hoursDraft);
    const validation = validateWeeklyGoal(selectedWeek.weekStart, reachouts, hours);
    if (!validation.ok) {
      setSaveState("error");
      setSaveMessage(goalValidationMessage(validation.error));
      return;
    }

    setSaveState("saving");
    setSaveMessage("");
    try {
      await onSave(selectedWeek.weekStart, reachouts, hours);
      setSaveState("saved");
      setSaveMessage("Goals saved for this week.");
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error && error.message === "AUTH_REQUIRED" ? "Unlock editing below, then save again." : "Could not save these goals.");
    }
  }

  async function handleAuthenticate() {
    if (!secretDraft) {
      setAuthState("error");
      return;
    }
    setAuthState("saving");
    try {
      await onAuthenticate(secretDraft);
      setSecretDraft("");
      setAuthState("idle");
      setSaveState("idle");
      setSaveMessage("Editing unlocked. Save the goals again.");
    } catch {
      setAuthState("error");
    }
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.2)] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Weekly goals</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-500">Set the expectation for each week. Earlier weeks keep the goal they were measured against.</p>
        </div>
        <span className="rounded-md border border-white/[0.08] bg-black/20 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-zinc-500">Effective from Monday</span>
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
                <option key={week.weekStart} value={week.weekStart}>Week of {week.label}</option>
              ))}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Messages / week
              <Input
                aria-label="Messages per week"
                className="mt-1 border-white/[0.1] bg-black/30 text-zinc-100"
                type="number"
                min={WEEKLY_GOAL_MIN_REACHOUTS}
                max={WEEKLY_GOAL_MAX_REACHOUTS}
                step={1}
                value={messagesDraft}
                onChange={(event) => setMessagesDraft(event.target.value)}
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

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={saveState === "saving"}>
              {saveState === "saving" ? "Saving…" : "Save goals"}
            </Button>
            <p className={cn("text-xs", saveState === "error" ? "text-rose-300" : saveState === "saved" ? "text-emerald-300" : "text-zinc-500")} role="status" aria-live="polite">
              {saveMessage || "Changes apply from the selected week forward until the next saved week."}
            </p>
          </div>
        </form>
      ) : null}

      {sessionRequired ? (
        <div className="mt-4 border-t border-white/[0.06] pt-4">
          <p className="text-xs text-zinc-400">Owner access is required to save ledger changes.</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Owner secret"
              className="border-white/[0.1] bg-black/30 text-zinc-100 sm:max-w-xs"
              type="password"
              autoComplete="current-password"
              placeholder="Owner secret"
              value={secretDraft}
              onChange={(event) => setSecretDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleAuthenticate();
                }
              }}
            />
            <Button type="button" size="sm" variant="outline" disabled={authState === "saving"} onClick={() => void handleAuthenticate()}>
              {authState === "saving" ? "Unlocking…" : "Unlock editing"}
            </Button>
          </div>
          {authState === "error" ? <p className="mt-2 text-xs text-rose-300" role="alert">That secret was not accepted.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
