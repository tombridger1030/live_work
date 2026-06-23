// Monochrome chart palette for the Tremor Raw charts. The product is dark-only
// and deliberately hue-free (Stripe/Linear/Vercel): data is distinguished by
// LUMINANCE, not colour. Each key maps to neutral Tailwind utilities; charts
// reference these by key (e.g. colors={["bright"]}). Keep this the single source
// of chart colour — no hex scattered through components.

export type AvailableChartColorsKeys = "bright" | "gray" | "mid" | "faint";

export const AvailableChartColors: AvailableChartColorsKeys[] = ["bright", "gray", "mid", "faint"];

type ColorUtility = "bg" | "stroke" | "fill" | "text";

const colorClassNames: Record<AvailableChartColorsKeys, Record<ColorUtility, string>> = {
  bright: { bg: "bg-zinc-200", stroke: "stroke-zinc-200", fill: "fill-zinc-200", text: "text-zinc-200" },
  gray: { bg: "bg-zinc-400", stroke: "stroke-zinc-400", fill: "fill-zinc-400", text: "text-zinc-400" },
  mid: { bg: "bg-zinc-500", stroke: "stroke-zinc-500", fill: "fill-zinc-500", text: "text-zinc-500" },
  faint: { bg: "bg-zinc-700", stroke: "stroke-zinc-700", fill: "fill-zinc-700", text: "text-zinc-700" }
};

export function constructCategoryColors(
  categories: string[],
  colors: AvailableChartColorsKeys[]
): Record<string, AvailableChartColorsKeys> {
  const categoryColors: Record<string, AvailableChartColorsKeys> = {};
  categories.forEach((category, index) => {
    categoryColors[category] = colors[index % colors.length];
  });
  return categoryColors;
}

export function getColorClassName(color: AvailableChartColorsKeys, type: ColorUtility): string {
  return colorClassNames[color]?.[type] ?? colorClassNames.gray[type];
}

// Recharts Y domain tuple. autoMinValue lets the axis float to the data's min;
// otherwise it pins to minValue (default 0) so bars read against a true baseline.
export function getYAxisDomain(
  autoMinValue: boolean,
  minValue: number | undefined,
  maxValue: number | undefined
): [number | string, number | string] {
  const min = autoMinValue ? "auto" : (minValue ?? 0);
  const max = maxValue ?? "auto";
  return [min, max];
}
