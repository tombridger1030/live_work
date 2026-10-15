"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DaySends, ScoreParts } from "@/lib/ledger";
import type { HoursPace } from "@/lib/hours-pace";
import type { OutreachGoal } from "@/lib/outreach-pace";
import { ledgerChartDayTick, sendLines } from "@/lib/ledger-ui";

type DailyRow = {
  day: string;
  label: string;
  dailyValue: number;
  scoreParts: ScoreParts;
  sends: DaySends; // what the day required, from its own week's goal
  outreachBar: OutreachGoal; // the day's own outreach bar, which names sends.outreach
  creditedHours: number;
  hoursTarget: number;
  hoursPace?: HoursPace;
  weekAverage: number | null;
};

type WeeklyRow = {
  weekStart: string;
  label: string;
  weeklyValue: number;
  touches: number; // what counts toward the week's outreach goal
  hours: number; // credited hours
  scoreParts: ScoreParts;
  baseValue: number; // weeklyValue before the email bonus
  emailBonus: number;
  touchesTarget: number;
  touchesUnit: string; // "touches", "requests", or "emails + requests", per that week's goal
  hoursTarget: number;
};

type LedgerChartsProps = {
  mode: "daily" | "weekly";
  dailyRows: DailyRow[];
  weeklyRows: WeeklyRow[];
  /** Full date of the open history day; null when no day is selected. */
  selectedDay: string | null;
  reduceMotion: boolean;
  intro: boolean;
};

// One stacked segment per score part. Steps of the app's own cyan / indigo /
// emerald, validated as a set on the dark card surface (#121212): lightness
// band, chroma, color-blind and normal-vision separation, and 3:1 contrast all
// pass (dataviz validator, 2026-10-13).
const SERIES = {
  sends: { color: "#0891b2", label: "Sends", of: "of 70" },
  hours: { color: "#6366f1", label: "Hours", of: "of 30" },
  bonus: { color: "#059669", label: "Email bonus", of: "up to 10" },
} as const;

const AXIS_TICKS = [0, 25, 50, 75, 100];
const axisTick = { fill: "#71717a", fontSize: 11 };
const chartMargin = { top: 10, right: 8, bottom: 0, left: 4 };
const BAR_MAX_WIDTH = 24;
const SEGMENT_GAP = 2; // surface-colored space between stacked segments
const BAR_RADIUS = 4; // rounded data end; square at the baseline
const UNSELECTED_OPACITY = 0.35;

function chartSurfaceClass(active: boolean): string {
  return `absolute inset-0 flex flex-col transition-opacity duration-150 ease-out motion-reduce:transition-none ${active ? "opacity-100" : "pointer-events-none opacity-0"}`;
}

// A rectangle with only its top corners rounded.
function topRoundedPath(
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const r = Math.min(BAR_RADIUS, width / 2, height);
  return [
    `M${x},${y + height}`,
    `L${x},${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    `L${x + width - r},${y}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `L${x + width},${y + height}`,
    "Z",
  ].join(" ");
}

type SegmentGeometry = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

/**
 * A Recharts `shape` for one stacked segment. The segment leaves a
 * SEGMENT_GAP of surface below it when something is stacked under it, rounds
 * its top only when it is the bar's top, and fades when another day is
 * selected. Empty segments draw nothing.
 */
function stackSegment<Row>(
  fill: string,
  {
    isTop,
    hasBelow,
    faded,
  }: {
    isTop: (row: Row) => boolean;
    hasBelow: (row: Row) => boolean;
    faded: (row: Row) => boolean;
  },
) {
  return function Segment(props: unknown) {
    const {
      x = 0,
      y = 0,
      width = 0,
      height = 0,
      payload,
    } = props as SegmentGeometry & { payload: Row };
    const visible = height - (hasBelow(payload) ? SEGMENT_GAP : 0);
    if (width <= 0 || visible < 1) {
      return <g />;
    }
    const opacity = faded(payload) ? UNSELECTED_OPACITY : 1;
    return isTop(payload) ? (
      <path
        d={topRoundedPath(x, y, width, visible)}
        fill={fill}
        fillOpacity={opacity}
      />
    ) : (
      <rect
        x={x}
        y={y}
        width={width}
        height={visible}
        fill={fill}
        fillOpacity={opacity}
      />
    );
  };
}

function LegendDot({ color }: { color: string }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

function LegendDash() {
  return (
    <svg width="14" height="2" aria-hidden className="shrink-0">
      <line
        x1="0"
        y1="1"
        x2="14"
        y2="1"
        stroke="#d4d4d8"
        strokeWidth="2"
        strokeDasharray="4 3"
      />
    </svg>
  );
}

function Legend({
  items,
}: {
  items: {
    key: string;
    mark: React.ReactNode;
    label: string;
    detail?: string;
  }[];
}) {
  return (
    <div className="flex h-7 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 pl-[34px] text-[11px] text-zinc-400">
      {items.map((item) => (
        <span key={item.key} className="inline-flex items-center gap-1.5">
          {item.mark}
          {item.label}
          {item.detail ? (
            <span className="text-zinc-600">{item.detail}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

// What a day's sends part was earned against: each kind against what that
// day required.
function sendsDetail(sends: DaySends, outreachBar: OutreachGoal): string {
  return sendLines(sends, outreachBar)
    .map(({ label, progress }) => `${label} ${progress.done}/${progress.required}`)
    .join(" · ");
}

function TooltipRow({
  mark,
  label,
  value,
  detail,
}: {
  mark: React.ReactNode;
  label: string;
  value: string;
  /** The raw counts behind the points, against that day's or week's own goal. */
  detail?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-6">
        <span className="inline-flex items-center gap-1.5 text-zinc-400">
          {mark}
          {label}
        </span>
        <span className="tabular-nums text-zinc-100">{value}</span>
      </div>
      {detail ? (
        <p className="pl-3.5 text-[11px] tabular-nums text-zinc-500">{detail}</p>
      ) : null}
    </div>
  );
}

function TooltipCard({
  title,
  total,
  children,
}: {
  title: string;
  total: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-44 rounded-2xl border border-white/[0.08] bg-zinc-950/96 px-3 py-2.5 text-xs shadow-2xl backdrop-blur">
      <div className="flex items-baseline justify-between gap-6">
        <p className="font-medium text-zinc-100">{title}</p>
        <p className="text-sm font-semibold tabular-nums text-zinc-50">
          {total}
        </p>
      </div>
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  );
}

// Lazy-loaded chart surfaces for the Ledger. One card, two modes, both stacked
// bars that show what each score is made of: sends (of 70) under hours (of
// 30), and on weeks the email bonus on top. Both stay mounted so switching is
// an interruptible opacity transition instead of an SVG teardown and replay.
// Kept out of SSR so the board stays stable.
export function LedgerCharts({
  mode,
  dailyRows,
  weeklyRows,
  selectedDay,
  reduceMotion,
  intro,
}: LedgerChartsProps) {
  const weeklyActive = mode === "weekly";
  const daily = dailyRows.map((row) => ({
    ...row,
    sendsPoints: row.scoreParts.goals,
    hoursPoints: row.scoreParts.hours,
  }));
  const weekly = weeklyRows.map((row) => ({
    ...row,
    sendsPoints: row.scoreParts.goals,
    hoursPoints: row.scoreParts.hours,
  }));
  const anyBonus = weekly.some((row) => row.emailBonus > 0);
  type Day = (typeof daily)[number];
  type Week = (typeof weekly)[number];
  const dayFaded = (row: Day) =>
    selectedDay !== null && row.day !== selectedDay;

  return (
    <div className="relative h-full">
      <div
        className={chartSurfaceClass(weeklyActive)}
        aria-hidden={!weeklyActive}
        inert={weeklyActive ? undefined : true}
      >
        <Legend
          items={[
            {
              key: "sends",
              mark: <LegendDot color={SERIES.sends.color} />,
              label: SERIES.sends.label,
              detail: SERIES.sends.of,
            },
            {
              key: "hours",
              mark: <LegendDot color={SERIES.hours.color} />,
              label: SERIES.hours.label,
              detail: SERIES.hours.of,
            },
            ...(anyBonus
              ? [
                  {
                    key: "bonus",
                    mark: <LegendDot color={SERIES.bonus.color} />,
                    label: SERIES.bonus.label,
                    detail: SERIES.bonus.of,
                  },
                ]
              : []),
          ]}
        />
        <div className="min-h-0 flex-1">
          <ResponsiveContainer
            minHeight={230}
            minWidth={0}
            initialDimension={{ width: 600, height: 230 }}
          >
            <ComposedChart
              data={weekly}
              margin={chartMargin}
              barCategoryGap="30%"
            >
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                minTickGap={20}
                tick={axisTick}
              />
              {/* A week with email bonus runs past 100; its bar rises above the dashed 100 line. */}
              <YAxis
                domain={[0, (dataMax: number) => Math.max(100, dataMax)]}
                ticks={AXIS_TICKS}
                axisLine={false}
                tickLine={false}
                width={30}
                tick={axisTick}
              />
              <Tooltip
                cursor={{ stroke: "rgba(255,255,255,0.12)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const week = active
                    ? (payload?.[0]?.payload as Week | undefined)
                    : undefined;
                  if (!week) {
                    return null;
                  }
                  return (
                    <TooltipCard
                      title={week.label}
                      total={
                        week.emailBonus > 0
                          ? `${week.baseValue} + ${week.emailBonus}`
                          : String(week.baseValue)
                      }
                    >
                      <TooltipRow
                        mark={<LegendDot color={SERIES.sends.color} />}
                        label="Sends"
                        value={`${week.sendsPoints} of 70`}
                        detail={`${week.touches} of ${week.touchesTarget} ${week.touchesUnit}`}
                      />
                      <TooltipRow
                        mark={<LegendDot color={SERIES.hours.color} />}
                        label="Hours"
                        value={`${week.hoursPoints} of 30`}
                        detail={`${week.hours.toFixed(1)} of ${week.hoursTarget} h`}
                      />
                      {week.emailBonus > 0 ? (
                        <TooltipRow
                          mark={<LegendDot color={SERIES.bonus.color} />}
                          label="Email bonus"
                          value={`+${week.emailBonus}`}
                        />
                      ) : null}
                    </TooltipCard>
                  );
                }}
              />
              <ReferenceLine
                y={100}
                stroke="rgba(255,255,255,0.16)"
                strokeDasharray="4 4"
              />
              <Bar
                dataKey="sendsPoints"
                stackId="score"
                maxBarSize={BAR_MAX_WIDTH}
                shape={stackSegment<Week>(SERIES.sends.color, {
                  isTop: (row) => row.hoursPoints === 0 && row.emailBonus === 0,
                  hasBelow: () => false,
                  faded: () => false,
                })}
                isAnimationActive={!reduceMotion}
                animationDuration={intro ? 520 : 0}
              />
              <Bar
                dataKey="hoursPoints"
                stackId="score"
                maxBarSize={BAR_MAX_WIDTH}
                shape={stackSegment<Week>(SERIES.hours.color, {
                  isTop: (row) => row.emailBonus === 0,
                  hasBelow: (row) => row.sendsPoints > 0,
                  faded: () => false,
                })}
                isAnimationActive={!reduceMotion}
                animationDuration={intro ? 520 : 0}
              />
              <Bar
                dataKey="emailBonus"
                stackId="score"
                maxBarSize={BAR_MAX_WIDTH}
                shape={stackSegment<Week>(SERIES.bonus.color, {
                  isTop: () => true,
                  hasBelow: (row) => row.baseValue > 0,
                  faded: () => false,
                })}
                isAnimationActive={!reduceMotion}
                animationDuration={intro ? 520 : 0}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div
        className={chartSurfaceClass(!weeklyActive)}
        aria-hidden={weeklyActive}
        inert={weeklyActive ? true : undefined}
      >
        <Legend
          items={[
            {
              key: "sends",
              mark: <LegendDot color={SERIES.sends.color} />,
              label: SERIES.sends.label,
              detail: SERIES.sends.of,
            },
            {
              key: "hours",
              mark: <LegendDot color={SERIES.hours.color} />,
              label: SERIES.hours.label,
              detail: SERIES.hours.of,
            },
            { key: "average", mark: <LegendDash />, label: "5-day average" },
          ]}
        />
        <div className="min-h-0 flex-1">
          <ResponsiveContainer
            minHeight={230}
            minWidth={0}
            initialDimension={{ width: 600, height: 230 }}
          >
            <ComposedChart
              data={daily}
              margin={chartMargin}
              barCategoryGap="18%"
            >
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={ledgerChartDayTick}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
                tick={axisTick}
              />
              <YAxis
                domain={[0, 100]}
                ticks={AXIS_TICKS}
                axisLine={false}
                tickLine={false}
                width={30}
                tick={axisTick}
              />
              <Tooltip
                cursor={{ stroke: "rgba(255,255,255,0.12)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const point = active
                    ? (payload?.[0]?.payload as Day | undefined)
                    : undefined;
                  if (!point) {
                    return null;
                  }
                  return (
                    <TooltipCard
                      title={point.label}
                      total={String(point.dailyValue)}
                    >
                      <TooltipRow
                        mark={<LegendDot color={SERIES.sends.color} />}
                        label="Sends"
                        value={`${point.sendsPoints} of 70`}
                        detail={sendsDetail(point.sends, point.outreachBar)}
                      />
                      <TooltipRow
                        mark={<LegendDot color={SERIES.hours.color} />}
                        label="Hours"
                        value={`${point.hoursPoints} of 30`}
                        detail={point.hoursPace?.expectedHours != null
                          ? `${point.creditedHours.toFixed(1)} of ${point.hoursPace.expectedHours.toFixed(1)} h expected now · ${point.hoursTarget.toFixed(1)} h daily goal`
                          : `${point.creditedHours.toFixed(1)} of ${point.hoursTarget.toFixed(1)} h`}
                      />
                      <TooltipRow
                        mark={<LegendDash />}
                        label="5-day average"
                        value={
                          point.weekAverage === null
                            ? "–"
                            : String(point.weekAverage)
                        }
                      />
                    </TooltipCard>
                  );
                }}
              />
              <ReferenceLine
                y={100}
                stroke="rgba(255,255,255,0.16)"
                strokeDasharray="4 4"
              />
              <Bar
                dataKey="sendsPoints"
                stackId="score"
                maxBarSize={BAR_MAX_WIDTH}
                shape={stackSegment<Day>(SERIES.sends.color, {
                  isTop: (row) => row.hoursPoints === 0,
                  hasBelow: () => false,
                  faded: dayFaded,
                })}
                isAnimationActive={!reduceMotion}
                animationDuration={intro ? 620 : 0}
              />
              <Bar
                dataKey="hoursPoints"
                stackId="score"
                maxBarSize={BAR_MAX_WIDTH}
                shape={stackSegment<Day>(SERIES.hours.color, {
                  isTop: () => true,
                  hasBelow: (row) => row.sendsPoints > 0,
                  faded: dayFaded,
                })}
                isAnimationActive={!reduceMotion}
                animationDuration={intro ? 620 : 0}
              />
              <Line
                type="monotone"
                dataKey="weekAverage"
                stroke="#d4d4d8"
                strokeOpacity={0.55}
                strokeDasharray="4 3"
                strokeWidth={1.5}
                strokeLinecap="round"
                dot={false}
                activeDot={false}
                connectNulls
                isAnimationActive={!reduceMotion}
                animationDuration={intro ? 720 : 0}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
