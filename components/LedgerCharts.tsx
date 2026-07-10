"use client";

import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type DailyRow = {
  day: string;
  label: string;
  dailyValue: number;
  movingAverage7: number | null;
};

type WeeklyRow = {
  weekStart: string;
  label: string;
  weeklyValue: number;
  reachouts: number;
  hours: number;
  features: number;
};

type LedgerChartsProps = {
  mode: "daily" | "weekly";
  dailyRows: DailyRow[];
  weeklyRows: WeeklyRow[];
  selectedDay: string;
  weeklyTargets: { reachouts: number; hours: number; features: number };
  reduceMotion: boolean;
  intro: boolean;
};

const AXIS_TICKS = [0, 25, 50, 75, 100];
const axisTick = { fill: "#71717a", fontSize: 11 };
const chartMargin = { top: 10, right: 8, bottom: 0, left: 4 };

// Lazy-loaded chart surfaces for the Ledger. One card, two modes: a clean daily
// score line (centered points, no grouped bars) and a weekly score bar whose
// tooltip spells out goal progress. Kept out of SSR so the board stays stable.
export function LedgerCharts({ mode, dailyRows, weeklyRows, selectedDay, weeklyTargets, reduceMotion, intro }: LedgerChartsProps) {
  if (mode === "weekly") {
    return (
      <div className="h-[230px]">
        <ResponsiveContainer minHeight={230} minWidth={0} initialDimension={{ width: 600, height: 230 }}>
          <RechartsBarChart data={weeklyRows} margin={chartMargin}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={20} tick={axisTick} />
            <YAxis domain={[0, 100]} ticks={AXIS_TICKS} axisLine={false} tickLine={false} width={30} tick={axisTick} />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) {
                  return null;
                }
                const week = payload[0]?.payload as WeeklyRow | undefined;
                if (!week) {
                  return null;
                }
                return (
                  <div className="rounded-2xl border border-white/[0.08] bg-zinc-950/96 px-3 py-2 text-xs shadow-2xl backdrop-blur">
                    <p className="font-medium text-zinc-100">{week.label}</p>
                    <div className="mt-2 space-y-1 text-zinc-400">
                      <div className="flex justify-between gap-6"><span>Score</span><span className="font-mono text-zinc-100">{week.weeklyValue}</span></div>
                      <div className="flex justify-between gap-6"><span>Reachouts</span><span className="font-mono text-zinc-100">{week.reachouts}/{weeklyTargets.reachouts}</span></div>
                      <div className="flex justify-between gap-6"><span>Hours</span><span className="font-mono text-zinc-100">{week.hours.toFixed(1)}/{weeklyTargets.hours}</span></div>
                      <div className="flex justify-between gap-6"><span>Features</span><span className="font-mono text-zinc-100">{week.features}/{weeklyTargets.features}</span></div>
                    </div>
                  </div>
                );
              }}
            />
            <ReferenceLine y={100} stroke="rgba(255,255,255,0.16)" strokeDasharray="4 4" />
            <Bar dataKey="weeklyValue" fill="rgba(168,85,247,0.85)" radius={[8, 8, 0, 0]} isAnimationActive={!reduceMotion} animationDuration={intro ? 520 : 0} />
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="h-[230px]">
      <ResponsiveContainer minHeight={230} minWidth={0} initialDimension={{ width: 600, height: 230 }}>
        <LineChart data={dailyRows} margin={chartMargin}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={24} tick={axisTick} />
          <YAxis domain={[0, 100]} ticks={AXIS_TICKS} axisLine={false} tickLine={false} width={30} tick={axisTick} />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.18)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) {
                return null;
              }
              const point = payload[0]?.payload as DailyRow | undefined;
              if (!point) {
                return null;
              }
              return (
                <div className="rounded-2xl border border-white/[0.08] bg-zinc-950/96 px-3 py-2 text-xs shadow-2xl backdrop-blur">
                  <p className="font-medium text-zinc-100">{point.label}</p>
                  <div className="mt-2 space-y-1 text-zinc-400">
                    <div className="flex justify-between gap-6"><span>Score</span><span className="font-mono text-zinc-100">{point.dailyValue}</span></div>
                    <div className="flex justify-between gap-6"><span>7-day avg</span><span className="font-mono text-zinc-100">{point.movingAverage7 ?? "—"}</span></div>
                  </div>
                </div>
              );
            }}
          />
          <ReferenceLine y={100} stroke="rgba(255,255,255,0.16)" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="movingAverage7"
            stroke="#a1a1aa"
            strokeDasharray="5 5"
            strokeWidth={1.5}
            dot={false}
            connectNulls
            isAnimationActive={!reduceMotion}
            animationDuration={intro ? 620 : 0}
          />
          <Line
            type="monotone"
            dataKey="dailyValue"
            stroke="#f8fafc"
            strokeWidth={2.5}
            isAnimationActive={!reduceMotion}
            animationDuration={intro ? 720 : 0}
            dot={({ cx, cy, payload }) => {
              if (typeof cx !== "number" || typeof cy !== "number") {
                return <g />;
              }
              const point = payload as DailyRow;
              const active = point.day === selectedDay;
              // Keep the line clean: only mark the selected day (scrubber) and
              // perfect (100) days; every other point is just the line.
              if (!active && point.dailyValue < 100) {
                return <g />;
              }
              return (
                <circle
                  cx={cx}
                  cy={cy}
                  r={active ? 5 : 4}
                  fill={active ? "#22d3ee" : "#f8fafc"}
                  stroke={active ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0)"}
                  strokeWidth={active ? 2 : 0}
                />
              );
            }}
            activeDot={{ r: 6, fill: "#22d3ee", stroke: "rgba(255,255,255,0.45)", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
