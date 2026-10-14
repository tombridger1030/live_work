import type { HoursPace, HoursPaceContext } from "@/lib/hours-pace";
import { HOURS_PACE_MIN_DAYS } from "@/lib/hours-pace";

/** Expected work and the deficit, with the learned baseline's visible provenance. */
export function HoursPaceReadout({
  pace,
  context,
}: {
  pace: HoursPace;
  context: HoursPaceContext;
}) {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: context.timeZone, hour: "numeric", minute: "2-digit",
  }).format(new Date(context.asOf));
  const delta = pace.deltaHours;
  const label = pace.state === "behind" ? `${Math.abs(delta!).toFixed(1)} h behind pace` :
    pace.state === "ahead" ? `${delta!.toFixed(1)} h ahead of pace` :
    pace.state === "done" ? "Daily goal met" :
    pace.state === "not due yet" ? "Not due yet" : "On your learned pace";
  return (
    <div className="space-y-1 text-xs tabular-nums" aria-label="Adaptive hours pace">
      {pace.expectedHours === null ? (
        <p className="text-zinc-400">Learning your pace</p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-zinc-300">Expected {pace.expectedHours.toFixed(1)} h by {time}</span>
          <span className={pace.state === "behind" ? "text-rose-300" :
            pace.state === "not due yet" ? "text-zinc-400" : "text-emerald-300"}>{label}</span>
        </div>
      )}
      <p className="text-[11px] leading-4 text-zinc-500">
        {context.closed ? "Day closed · scored against the full daily goal" :
          context.basis === "learning" ? `Needs ${HOURS_PACE_MIN_DAYS} comparable captured workdays` :
          context.basis === "successful" ? `Based on ${context.referenceDays.length} goal-reaching workdays` :
            `Learning from ${context.referenceDays.length} stronger recent workdays`}
      </p>
    </div>
  );
}
