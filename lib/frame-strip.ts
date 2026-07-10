/**
 * Clamps a requested strip window to the frames that actually exist.
 *
 * Preconditions: indexes are zero-based. Postconditions: `start <= end`,
 * `end - start <= visibleCount`, and the returned window never points past the
 * newest stored frame.
 */
export function frameStripRange(frameCount: number, startIndex: number, visibleCount: number): { start: number; end: number } {
  if (frameCount <= 0 || visibleCount <= 0) {
    return { start: 0, end: 0 };
  }

  const clampedVisible = Math.min(frameCount, Math.max(1, visibleCount));
  const maxStart = frameCount - clampedVisible;
  const start = Math.min(Math.max(0, startIndex), maxStart);
  return { start, end: start + clampedVisible };
}

/**
 * Picks the strip start that keeps a selected snapshot visible, biased toward
 * the newest side so the latest frame lands on the right edge of the strip.
 */
export function frameStripStartForSelection(frameCount: number, selectedIndex: number, visibleCount: number): number {
  if (frameCount <= 0 || visibleCount <= 0) {
    return 0;
  }

  const clampedVisible = Math.min(frameCount, Math.max(1, visibleCount));
  const clampedIndex = Math.min(Math.max(selectedIndex, 0), frameCount - 1);
  return frameStripRange(frameCount, clampedIndex - clampedVisible + 1, clampedVisible).start;
}
/**
 * Moves the strip by one whole section. The step matches the visible window
 * width, so paging never advances one card at a time.
 */
export function shiftFrameStripWindow(
  frameCount: number,
  currentStart: number,
  visibleCount: number,
  direction: -1 | 1
): number {
  if (frameCount <= 0 || visibleCount <= 0) {
    return 0;
  }

  const step = Math.min(frameCount, Math.max(1, visibleCount));
  return frameStripRange(frameCount, currentStart + direction * step, visibleCount).start;
}
