"use client";

import { LayoutGroup, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Tally5 } from "lucide-react";
import { appQuick } from "@/components/MotionPrimitives";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "tally" },
  { href: "/ledger", label: "ledger" }
];

// The single brand + surface switcher, mounted once above both pages. The pill
// follows intent immediately while the destination's server data resolves, then
// the URL remains the source of truth once navigation completes.
export function TopNav() {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  const visualPath = pendingHref ?? pathname;
  return (
    <nav
      aria-busy={pendingHref !== null}
      className="sticky top-0 z-40 border-b border-white/[0.04] bg-background/80 backdrop-blur"
    >
      <LayoutGroup id="app-nav">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-5 py-3">
          <Tally5 className="size-4 shrink-0 text-foreground" strokeWidth={2.5} aria-hidden />
          {items.map((item) => {
            const current = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const active = item.href === "/" ? visualPath === "/" : visualPath.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={true}
                aria-current={current ? "page" : undefined}
                className="relative inline-flex min-h-10 items-center rounded-full px-3.5 text-sm transition-[color,scale] duration-150 ease-out active:scale-[0.96]"
                onClick={(event) => {
                  if (
                    item.href !== pathname &&
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    setPendingHref(item.href);
                  }
                }}
              >
                {active && (
                  <motion.span
                    layoutId="app-nav-active"
                    className="absolute inset-0 rounded-full bg-white"
                    transition={appQuick}
                  />
                )}
                <span className={cn("relative z-10", active ? "text-black" : "text-zinc-500 hover:text-zinc-200")}>
                  {item.label}
                </span>
              </Link>
            );
          })}
        </div>
      </LayoutGroup>
    </nav>
  );
}
