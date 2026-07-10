"use client";

import { GeistMono } from "geist/font/mono";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { appQuick, motionTransition } from "@/components/MotionPrimitives";
import { cn } from "@/lib/utils";

type NumProps = {
  children: string;
  className?: string;
  animate?: boolean;
};

// Tabular-figure numeral shared by both surfaces. Digit changes animate in place so
// values feel caused, not swapped, while reduced-motion users still get stable text.
export function Num({ children, className, animate = true }: NumProps) {
  const reduceMotion = useReducedMotion() ?? false;

  // Branch only on the `animate` PROP (identical on server + client). Branching on
  // useReducedMotion() would render a different tree on a reduced-motion client
  // than the server did → hydration mismatch (React #418). Reduced motion instead
  // just collapses the transition to near-instant.
  if (!animate) {
    return (
      <span className={cn("tabular-nums", className)} style={GeistMono.style}>
        {children}
      </span>
    );
  }

  return (
    <span className={cn("relative inline-flex overflow-hidden tabular-nums", className)} style={GeistMono.style}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={children}
          initial={{ opacity: 0, y: "0.35em", filter: "blur(4px)" }}
          animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
          exit={{ opacity: 0, y: "-0.35em", filter: "blur(4px)" }}
          transition={motionTransition(reduceMotion, appQuick)}
          className="block will-change-transform"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
