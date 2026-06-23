"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createReturnRefresher } from "@/lib/return-refresh";

/**
 * Refreshes Server Component / cached route data via router.refresh() when the
 * user returns to the tab/window — on window focus, tab focus
 * (visibilitychange → "visible"), and bfcache restore (pageshow with
 * event.persisted). It is event-driven, so there is no polling while the tab is
 * hidden; router.refresh() preserves scroll and client state and never triggers
 * a full-page reload. Refetches are throttled (default 2s) so rapid tab switching
 * stays snappy without spamming requests. Mount once from a client component.
 */
export function useRefreshOnReturn(throttleMs = 2_000): void {
  const router = useRouter();

  useEffect(() => {
    const refresher = createReturnRefresher(() => router.refresh(), { throttleMs });
    const onFocus = (): void => refresher.onFocus();
    const onVisibility = (): void => refresher.onVisibility(document.visibilityState);
    const onPageShow = (event: PageTransitionEvent): void => refresher.onPageShow(event.persisted);

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [router, throttleMs]);
}
