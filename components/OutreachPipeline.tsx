"use client";

import { motion, useReducedMotion } from "motion/react";
import { appSpring, motionTransition } from "@/components/MotionPrimitives";
import { Num } from "@/components/Num";
import type {
  FunnelStatus,
  FunnelStep,
  OutreachFunnel,
} from "@/lib/outreach-funnel";
import { cn } from "@/lib/utils";

const monthDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

function shortDay(day: string): string {
  return monthDay.format(new Date(`${day}T12:00:00Z`));
}

function statusTone(status: FunnelStatus | null): string {
  switch (status) {
    case "low":
      return "text-rose-300";
    case "on target":
      return "text-emerald-300";
    default:
      return "text-zinc-500";
  }
}

// One stage: how many reached it, what share of the stage before converted,
// and that stage's target. The rate carries the verdict by color alone, so each
// row stays one line. The bar is scaled to the first stage so the column reads
// as a funnel narrowing top to bottom.
function StepRow({ step, top }: { step: FunnelStep; top: number }) {
  const reduceMotion = useReducedMotion() ?? false;
  const width =
    top > 0
      ? `${Math.max(step.count > 0 ? 2 : 0, Math.min(100, (step.count / top) * 100))}%`
      : "0%";
  const rate = step.rate === null ? "–" : `${Math.round(step.rate * 100)}%`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_3rem_3.5rem_3.5rem] items-center gap-x-2 py-2 text-sm">
      <span className="truncate text-zinc-200">{step.label}</span>
      <Num
        animate={false}
        className="text-right font-semibold tabular-nums text-zinc-50"
      >
        {String(step.count)}
      </Num>
      <span
        className={cn(
          "text-right tabular-nums",
          step.status === null ? "text-transparent" : statusTone(step.status),
        )}
      >
        {step.status === null ? "" : rate}
      </span>
      <span className="text-right text-xs tabular-nums text-zinc-500">
        {step.target?.label ?? ""}
      </span>
      <div className="col-span-4 mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.04]">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-sky-400/70 to-teal-300/80"
          initial={reduceMotion ? false : { width: 0 }}
          animate={{ width }}
          transition={motionTransition(reduceMotion, appSpring)}
        />
      </div>
    </li>
  );
}

function Channel({
  title,
  steps,
  footer,
}: {
  title: string;
  steps: FunnelStep[];
  footer?: React.ReactNode;
}) {
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_3rem_3.5rem_3.5rem] gap-x-2 border-b border-white/[0.06] pb-1.5 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
        <span>{title}</span>
        <span className="text-right">Count</span>
        <span className="text-right">Rate</span>
        <span className="text-right">Target</span>
      </div>
      <ol>
        {steps.map((step) => (
          <StepRow key={step.key} step={step} top={steps[0].count} />
        ))}
      </ol>
      {footer}
    </div>
  );
}

/**
 * Where outreach falls out, per channel, over the last 28 days. The headline
 * names the first LinkedIn stage below target, so the owner knows whether to
 * send more, message the people who accepted, or rewrite the message.
 */
export function OutreachPipeline({ funnel }: { funnel: OutreachFunnel }) {
  const firstLow = funnel.linkedin.find((step) => step.status === "low");
  const headlineTone =
    funnel.fromDay === null
      ? "text-zinc-400"
      : firstLow
        ? "text-rose-200"
        : "text-zinc-200";
  return (
    <section
      aria-labelledby="outreach-pipeline-title"
      className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.2)] sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="outreach-pipeline-title"
          className="text-sm font-semibold text-zinc-100"
        >
          Outreach pipeline
        </h2>
        <p className="text-[11px] text-zinc-500">
          {funnel.fromDay === null
            ? "Last 28 days"
            : `${shortDay(funnel.fromDay)} – ${shortDay(funnel.toDay)}`}
        </p>
      </div>
      <p className={cn("mt-2 text-sm leading-6", headlineTone)}>
        {funnel.headline}
      </p>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <Channel title="LinkedIn" steps={funnel.linkedin} />
        <Channel
          title="Email"
          steps={funnel.email}
          footer={
            <p className="mt-3 text-[11px] text-zinc-500">
              <span className="tabular-nums text-zinc-300">
                {funnel.emailFollowUps}
              </span>{" "}
              follow-ups sent. Email has no targets yet, so its rates carry no
              verdict.
            </p>
          }
        />
      </div>
      <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11px] leading-4 text-zinc-500">
        Each rate is against the step above it.{" "}
        <span className="text-emerald-300">Green</span> meets the target,{" "}
        <span className="text-rose-300">red</span> is below it, and grey means
        fewer than 10 in the step above, too few to judge.
      </p>
    </section>
  );
}
