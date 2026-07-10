"use client";

import { motion, useReducedMotion } from "motion/react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { appQuick, motionTransition } from "@/components/MotionPrimitives";

// Surface order for directional transitions: tally on the left, ledger on the
// right. Visiting ledger swishes in from the right; coming back swishes from the
// left — so the motion mirrors where the page lives in the nav.
const ORDER = ["/", "/ledger"];
function surfaceIndex(pathname: string): number {
  return pathname.startsWith("/ledger") ? 1 : 0;
}

// Module-scoped so the previous surface survives template remounts (Next mounts a
// fresh template per navigation). Only used to pick the swish direction.
let previousPath: string | null = null;

// Route transition: a quick horizontal swish, never a skeleton. Cached revisits
// render instantly and just slide in; first loads hold the prior page until the
// server is ready, then slide — no flash.
export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const reduceMotion = hydrated && prefersReducedMotion;
  const forward = previousPath === null ? true : surfaceIndex(pathname) >= surfaceIndex(previousPath);
  previousPath = pathname;
  const enterX = reduceMotion ? 0 : forward ? 26 : -26;

  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, x: enterX }}
      animate={{ opacity: 1, x: 0 }}
      transition={motionTransition(reduceMotion, appQuick)}
      className="min-h-[calc(100vh-57px)]"
    >
      {children}
    </motion.div>
  );
}
