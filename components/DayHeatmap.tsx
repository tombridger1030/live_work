"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { DayHistory } from "@/lib/types";
import { cn } from "@/lib/utils";

type ProtoHeatmapProps = {
  history: DayHistory[];
  today: string;
  viewDay: string;
};

type Cell = { day: string | null; entry: DayHistory | undefined };

const MAX_WEEKS = 53;
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
const monthYearFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" });
const fullFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Focus heatmap ramp: neutral dark for days with no data, then a single-hue green
// scale that brightens with the day's average focus. Steps are spaced for clear
// shade-to-shade contrast on the near-black grid (the old grayscale ramp was hard
// to read), and green ties the map to the green "improved" deltas above it.
function cellColor(entry: DayHistory | undefined): string {
  if (!entry) return "#18181b"; // no data — neutral, distinct from a low-focus day
  if (entry.avgScore >= 90) return "#45d977"; // peak focus
  if (entry.avgScore >= 75) return "#2cbb61";
  if (entry.avgScore >= 50) return "#229c51";
  if (entry.avgScore >= 25) return "#1a7d42";
  if (entry.avgScore >= 10) return "#135a32";
  return "#0d3321"; // tracked but barely focused
}

export function DayHeatmap({ history, today, viewDay }: ProtoHeatmapProps) {
  const { fullWeeks, mobileWeeks, monthLabels, mobileMonthLabels, rangeLabel, mobileRangeLabel } = useMemo(() => {
    const byDay = new Map(history.map((entry) => [entry.day, entry]));

    let firstDay = today;
    for (const entry of history) {
      if (entry.day < firstDay) firstDay = entry.day;
    }
    const start = new Date(`${firstDay}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());

    // Full year (53 weeks)
    const fullDays: string[] = [];
    for (let offset = 0; offset < MAX_WEEKS * 7; offset += 1) {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + offset);
      const key = dayKey(date);
      fullDays.push(key <= today ? key : "");
    }

    // Mobile view (last 5 weeks = 35 days, covers ~30 days of data)
    const mobileStart = new Date(today);
    mobileStart.setUTCDate(mobileStart.getUTCDate() - 34); // 35 days total (5 weeks)
    mobileStart.setUTCDate(mobileStart.getUTCDate() - mobileStart.getUTCDay()); // align to Sunday
    const mobileDays: string[] = [];
    for (let offset = 0; offset < 5 * 7; offset += 1) {
      const date = new Date(mobileStart);
      date.setUTCDate(date.getUTCDate() + offset);
      const key = dayKey(date);
      mobileDays.push(key <= today ? key : "");
    }

    const fullColumns: Cell[][] = [];
    for (let index = 0; index < fullDays.length; index += 7) {
      fullColumns.push(fullDays.slice(index, index + 7).map((day) => ({ day, entry: byDay.get(day) })));
    }

    const mobileColumns: Cell[][] = [];
    for (let index = 0; index < mobileDays.length; index += 7) {
      mobileColumns.push(mobileDays.slice(index, index + 7).map((day) => ({ day, entry: byDay.get(day) })));
    }

    // Month labels for full year
    let lastMonth = "";
    const fullLabels = fullColumns.map((column) => {
      const firstValidDay = column.find((cell) => cell.day);
      if (!firstValidDay?.day) return null;
      const month = monthFmt.format(new Date(`${firstValidDay.day}T12:00:00Z`));
      if (month === lastMonth) return null;
      lastMonth = month;
      return month;
    });

    // Month labels for mobile view
    let lastMobileMonth = "";
    const mobileLabels = mobileColumns.map((column) => {
      const firstValidDay = column.find((cell) => cell.day);
      if (!firstValidDay?.day) return null;
      const month = monthFmt.format(new Date(`${firstValidDay.day}T12:00:00Z`));
      if (month === lastMobileMonth) return null;
      lastMobileMonth = month;
      return month;
    });

    // Range labels
    const firstDataDay = history.at(-1)?.day ?? today;
    const rangeLabel = `${monthYearFmt.format(new Date(`${firstDataDay}T12:00:00Z`))} – ${monthYearFmt.format(new Date(`${today}T12:00:00Z`))}`;
    const mobileRangeLabel = `${monthFmt.format(new Date(`${mobileDays.find(d => d) ?? today}T12:00:00Z`))} – ${monthFmt.format(new Date(`${today}T12:00:00Z`))}`;

    return {
      fullWeeks: fullColumns,
      mobileWeeks: mobileColumns,
      monthLabels: fullLabels,
      mobileMonthLabels: mobileLabels,
      rangeLabel,
      mobileRangeLabel
    };
  }, [history, today]);

  function renderGrid(weeks: Cell[][], labels: (string | null)[], label: string) {
    return (
      <div className="flex w-full flex-col gap-1.5">
        <div className="flex gap-[3px]">
          <div className="mr-1 w-8 shrink-0" aria-hidden />
          {labels.map((monthLabel, index) => (
            <div key={index} className="relative h-3 max-w-5 flex-1">
              {monthLabel ? <span className="absolute left-0 text-[10px] leading-none text-zinc-500">{monthLabel}</span> : null}
            </div>
          ))}
        </div>
        <div className="flex gap-[3px]">
          <div className="mr-1 flex w-8 shrink-0 flex-col gap-[3px]">
            {WEEKDAY_LABELS.map((dayLabel, index) => (
              <div key={index} className="flex flex-1 items-center justify-end text-[10px] leading-none text-zinc-500">
                {dayLabel}
              </div>
            ))}
          </div>
          {weeks.map((week, weekIndex) => (
            <div key={weekIndex} className="flex max-w-5 flex-1 flex-col gap-[3px]">
              {week.map((cell, dayIndex) => {
                if (!cell.day) {
                  return <div key={dayIndex} className="aspect-square w-full" aria-hidden />;
                }
                const isView = cell.day === viewDay;
                const ring = isView ? "ring-1 ring-zinc-100 ring-offset-1 ring-offset-zinc-950" : "";
                return (
                  <Link
                    key={dayIndex}
                    href={`/?day=${cell.day}`}
                    aria-label={`${fullFmt.format(new Date(`${cell.day}T12:00:00Z`))}${cell.entry ? `: focus ${cell.entry.avgScore}, ${cell.entry.hours} hours tracked` : ": no data"}`}
                    className={cn("block aspect-square w-full rounded-[3px] transition hover:opacity-85", ring)}
                    style={{ backgroundColor: cellColor(cell.entry) }}
                    title={cell.entry ? `${fullFmt.format(new Date(`${cell.day}T12:00:00Z`))} · Focus ${cell.entry.avgScore} · ${cell.entry.presentPct}% present · ${cell.entry.hours}h tracked` : `${fullFmt.format(new Date(`${cell.day}T12:00:00Z`))} · No data`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby="proto-history-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="proto-history-heading" className="text-sm font-semibold text-zinc-100">
          History
        </h2>
        <p className="hidden text-[11px] text-zinc-500 md:block">{rangeLabel}</p>
        <p className="text-[11px] text-zinc-500 md:hidden">{mobileRangeLabel}</p>
      </div>

      <div className="overflow-x-auto md:hidden">
        {renderGrid(mobileWeeks, mobileMonthLabels, "mobile")}
      </div>
      <div className="hidden overflow-x-auto md:block">
        {renderGrid(fullWeeks, monthLabels, "desktop")}
      </div>
    </section>
  );
}
