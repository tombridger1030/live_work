type Clock = () => number;

export type ReturnRefresher = {
  onFocus: () => void;
  onVisibility: (state: DocumentVisibilityState) => void;
  onPageShow: (persisted: boolean) => void;
};

/**
 * Throttled "user returned to the tab" refresh trigger. Pure and DOM-free so the
 * gating is unit-testable without a browser: window focus and visibility changes
 * both refresh after the throttle window; pageshow only fires on a bfcache restore
 * (persisted === true); and all return signals share ONE throttle so rapid tab
 * flips refresh at most once per throttleMs.
 *
 * `now` is injectable for tests (defaults to Date.now). The throttle clock starts
 * at construction, so a return within throttleMs of load — when the SSR data is
 * still fresh — does not refetch. Returns within the window are dropped silently.
 */
/**
 * True when the rendered dashboard is behind the server's latest snapshot.
 * A non-null status id is authoritative; null means the server has no snapshot
 * yet and must not force a reload loop.
 */
export function shouldReloadForLatestSnapshot(renderedLatestId: string | null, statusLatestId: string | null): boolean {
  return statusLatestId !== null && statusLatestId !== renderedLatestId;
}

export function createReturnRefresher(
  refresh: () => void,
  options: { throttleMs?: number; now?: Clock } = {}
): ReturnRefresher {
  const throttleMs = options.throttleMs ?? 30_000;
  const now = options.now ?? Date.now;
  let lastRefresh = now();

  function trigger(): void {
    const at = now();
    if (at - lastRefresh >= throttleMs) {
      lastRefresh = at;
      refresh();
    }
  }

  return {
    onFocus() {
      trigger();
    },
    onVisibility(state) {
      if (state === "visible") {
        trigger();
      }
    },
    onPageShow(persisted) {
      if (persisted) {
        trigger();
      }
    }
  };
}
