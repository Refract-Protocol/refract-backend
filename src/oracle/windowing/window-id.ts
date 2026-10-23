/**
 * Deterministic window ID computation.
 *
 * A window ID is a wall-clock-aligned bucket identifier:
 *   `${feedId}:${windowStart.toISOString()}`
 *
 * Window boundaries are computed by flooring the source timestamp to the
 * nearest multiple of windowDurationMs from Unix epoch, so:
 *   - All readings with the same (feedId, source-timestamp bucket) land in
 *     the same window regardless of backend processing order.
 *   - Window IDs are reproducible from the input data alone — replay is exact.
 */

export interface WindowBounds {
  windowId: string;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Returns the window that contains `sourceTimestamp` for the given feed
 * and window duration. The window is aligned to Unix epoch so the same
 * input always produces the same window ID across replicas and restarts.
 */
export function computeWindowBounds(
  feedId: string,
  sourceTimestamp: Date,
  windowDurationMs: number,
): WindowBounds {
  const ts = sourceTimestamp.getTime();
  const windowStart = new Date(Math.floor(ts / windowDurationMs) * windowDurationMs);
  const windowEnd = new Date(windowStart.getTime() + windowDurationMs);
  const windowId = `${feedId}:${windowStart.toISOString()}`;
  return { windowId, windowStart, windowEnd };
}

/**
 * The watermark for a window is the instant after which no new readings
 * are accepted into that window even if their source timestamp falls inside it.
 *
 *   watermark = windowEnd + allowedLatenessMs
 */
export function computeWatermark(windowEnd: Date, allowedLatenessMs: number): Date {
  return new Date(windowEnd.getTime() + allowedLatenessMs);
}

/**
 * Returns true if `arrivalTime` is after the watermark — i.e. the reading
 * has arrived too late to be counted even as a late reading.
 */
export function isArrivedTooLate(
  arrivalTime: Date,
  windowEnd: Date,
  allowedLatenessMs: number,
): boolean {
  return arrivalTime.getTime() > computeWatermark(windowEnd, allowedLatenessMs).getTime();
}

/**
 * Returns true if the reading arrived after windowEnd but before the watermark.
 * Such readings are flagged as "late" and handled per lateArrivalPolicy.
 */
export function isLateArrival(arrivalTime: Date, windowEnd: Date): boolean {
  return arrivalTime.getTime() > windowEnd.getTime();
}

/**
 * Returns true when the window is closed: current wall-clock time is past
 * the window's end. Consensus should only be evaluated on closed windows
 * (unless the feed is configured best-effort).
 */
export function isWindowClosed(windowEnd: Date, now: Date = new Date()): boolean {
  return now.getTime() >= windowEnd.getTime();
}
