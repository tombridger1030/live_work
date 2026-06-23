"use client";

import {
  Bar,
  CartesianGrid,
  LabelList,
  BarChart as RechartsBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  AvailableChartColors,
  constructCategoryColors,
  getColorClassName,
  getYAxisDomain,
  type AvailableChartColorsKeys
} from "@/lib/chartUtils";
import { cn } from "@/lib/utils";

// Tremor Raw BarChart, adapted: monochrome (luminance-only) palette, dark-first,
// fully typed for this repo (no `any`), single- or multi-series. Recharts is the
// engine (same as Tremor); we own the component so it matches the design system.

type ChartDatum = Record<string, string | number | boolean>;

type BarChartProps = {
  data: ChartDatum[];
  index: string; // datum key shown on the x-axis
  categories: string[]; // datum keys drawn as bar series
  colors?: AvailableChartColorsKeys[];
  valueFormatter?: (value: number) => string;
  showYAxis?: boolean;
  startEndOnly?: boolean; // label only first/last tick — for dense axes
  className?: string;
  onBarSelect?: (datum: ChartDatum) => void;
  markKey?: string; // truthy datum key rendered as a small marker above a bar
};

type TooltipEntry = { dataKey?: string | number; value?: number };
function extractPayload(value: unknown): ChartDatum | null {
  if (!value || typeof value !== "object" || !("payload" in value)) {
    return null;
  }
  const payload = (value as { payload: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record: ChartDatum = {};
  for (const [key, entry] of Object.entries(payload)) {
    if (typeof entry === "string" || typeof entry === "number") {
      record[key] = entry;
    }
  }
  return record;
}

function ChartTooltip({
  active,
  label,
  payload,
  categoryColors,
  valueFormatter
}: {
  active?: boolean;
  label?: string | number;
  payload?: TooltipEntry[];
  categoryColors: Record<string, AvailableChartColorsKeys>;
  valueFormatter: (value: number) => string;
}) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <p className="mb-1 font-medium text-zinc-100">{label}</p>
      <div className="space-y-1">
        {payload.map((entry) => {
          const key = String(entry.dataKey ?? "");
          return (
            <div key={key} className="flex items-center justify-between gap-6">
              <span className="flex items-center gap-1.5 text-zinc-400">
                <span
                  className={cn("size-2 rounded-xs", getColorClassName(categoryColors[key] ?? "gray", "bg"))}
                  aria-hidden
                />
                {key}
              </span>
              <span className="font-mono tabular-nums text-zinc-100">{valueFormatter(entry.value ?? 0)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BarChart({
  data,
  index,
  categories,
  colors = AvailableChartColors,
  valueFormatter = (value) => String(value),
  showYAxis = true,
  startEndOnly = false,
  className,
  onBarSelect,
  markKey
}: BarChartProps) {
  const categoryColors = constructCategoryColors(categories, colors);

  return (
    <div className={cn("h-44 w-full", className)}>
      <ResponsiveContainer>
        <RechartsBarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="22%">
          <CartesianGrid className="stroke-white/[0.06]" horizontal vertical={false} />
          <XAxis
            dataKey={index}
            fill=""
            stroke=""
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#71717a", fontSize: 11, transform: "translate(0, 6)" }}
            tickMargin={4}
            minTickGap={4}
            interval={startEndOnly ? "preserveStartEnd" : "equidistantPreserveStart"}
          />
          <YAxis
            hide={!showYAxis}
            domain={getYAxisDomain(false, 0, undefined)}
            fill=""
            stroke=""
            tickLine={false}
            axisLine={false}
            width={30}
            tickFormatter={(value: number) => valueFormatter(value)}
            tick={{ fill: "#71717a", fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            isAnimationActive={false}
            offset={12}
            content={({ active, label, payload }) => (
              <ChartTooltip
                active={active}
                label={typeof label === "string" || typeof label === "number" ? label : undefined}
                // recharts' payload type → our minimal entry shape
                payload={payload as unknown as TooltipEntry[] | undefined}
                categoryColors={categoryColors}
                valueFormatter={valueFormatter}
              />
            )}
          />
          {categories.map((category) => (
            <Bar
              key={category}
              dataKey={category}
              fill=""
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
              className={getColorClassName(categoryColors[category] ?? "gray", "fill")}
              onClick={(value: unknown) => {
                const payload = extractPayload(value);
                if (payload) {
                  onBarSelect?.(payload);
                }
              }}
            >
              {markKey ? (
                <LabelList
                  dataKey={markKey}
                  position="top"
                  formatter={(value: unknown) => (value === true || value === 1 || value === "true" ? "★" : "")}
                  fill="#45d977"
                  fontSize={12}
                  offset={4}
                />
              ) : null}
            </Bar>
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
