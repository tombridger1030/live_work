"use client";

import { GeistMono } from "geist/font/mono";
import { animate, useMotionValue, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type RollingNumberProps = {
  value: number;
  decimals?: 0 | 1;
  prefix?: string;
  suffix?: string;
  className?: string;
};

// Tabular-figure number that tallies from its previous value to the next instead
// of cutting. The suffix (e.g. "%", "h") renders as a separate, un-clipped span so
// it can never be shaved off. Reduced-motion users get an instant snap.
export function RollingNumber({ value, decimals = 0, prefix = "", suffix = "", className }: RollingNumberProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const motionValue = useMotionValue(value);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    if (reduceMotion) {
      setDisplay(value);
      return;
    }
    const controls = animate(motionValue, value, { duration: 0.55, ease: [0.22, 1, 0.36, 1] });
    const unsubscribe = motionValue.on("change", (latest) => setDisplay(latest));
    return () => {
      controls.stop();
      unsubscribe();
    };
  }, [value, reduceMotion, motionValue]);

  return (
    <span className={cn("tabular-nums", className)} style={GeistMono.style}>
      {prefix}
      {display.toFixed(decimals)}
      {suffix ? <span>{suffix}</span> : null}
    </span>
  );
}
