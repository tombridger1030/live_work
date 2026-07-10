"use client";

import { LayoutGroup, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tally5 } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "tally" },
  { href: "/ledger", label: "ledger" }
];

// The single brand + surface switcher, mounted once in the layout above both
// pages. Active pill glides between nav items using motion's layoutId.
export function TopNav() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-40 border-b border-white/[0.04] bg-background/80 backdrop-blur">
      <LayoutGroup id="app-nav">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-5 py-3">
          <Tally5 className="size-4 shrink-0 text-foreground" strokeWidth={2.5} aria-hidden />
          {items.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={true}
                aria-current={active ? "page" : undefined}
                className="relative rounded-full px-3.5 py-2 text-sm transition-colors duration-200 active:scale-[0.96]"
              >
                {active && (
                  <motion.span
                    layoutId="app-nav-active"
                    className="absolute inset-0 rounded-full bg-white"
                    transition={{ type: "spring", duration: 0.32, bounce: 0 }}
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
