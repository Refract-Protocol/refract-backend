/**
 * Per-feed consensus window configuration.
 *
 * Each feed (coverage type) has its own window duration and lateness policy.
 * Windows are wall-clock aligned buckets keyed by (feedId, windowId).
 */

/** What to do with a reading that arrives after the watermark but whose
 *  source timestamp falls inside an already-closed window. */
export type LateArrivalPolicy = "drop" | "carry_next";

export interface FeedWindowConfig {
  /** Coverage-type identifier (matches OracleReading.coverageType). */
  feedId: string;
  /** Window duration in milliseconds. */
  windowDurationMs: number;
  /**
   * How long after window close the backend still accepts late readings
   * (milliseconds). Readings arriving beyond this are always dropped.
   */
  allowedLatenessMs: number;
  /** What to do with accepted-late readings for closed-window consensus. */
  lateArrivalPolicy: LateArrivalPolicy;
  /**
   * When true, consensus may be emitted over a partially filled window
   * (i.e. before the watermark). Intended only for feeds where low latency
   * matters more than determinism.
   */
  bestEffort: boolean;
}

/** Default window configs per coverage type (30-second windows, 5s lateness). */
export const DEFAULT_FEED_WINDOW_CONFIGS: FeedWindowConfig[] = [
  {
    feedId: "StablecoinDepeg",
    windowDurationMs: 30_000,
    allowedLatenessMs: 5_000,
    lateArrivalPolicy: "drop",
    bestEffort: false,
  },
  {
    feedId: "MarketCrash",
    windowDurationMs: 30_000,
    allowedLatenessMs: 5_000,
    lateArrivalPolicy: "drop",
    bestEffort: false,
  },
  {
    feedId: "LiquidationShield",
    windowDurationMs: 30_000,
    allowedLatenessMs: 5_000,
    lateArrivalPolicy: "carry_next",
    bestEffort: false,
  },
  {
    feedId: "SmartContractRisk",
    windowDurationMs: 30_000,
    allowedLatenessMs: 5_000,
    lateArrivalPolicy: "drop",
    bestEffort: false,
  },
  {
    feedId: "FlightDelay",
    windowDurationMs: 60_000,
    allowedLatenessMs: 10_000,
    lateArrivalPolicy: "carry_next",
    bestEffort: true,
  },
];

/** Looks up a feed config, falling back to a default 30s window. */
export function getFeedConfig(
  feedId: string,
  configs: FeedWindowConfig[] = DEFAULT_FEED_WINDOW_CONFIGS,
): FeedWindowConfig {
  return (
    configs.find((c) => c.feedId === feedId) ?? {
      feedId,
      windowDurationMs: 30_000,
      allowedLatenessMs: 5_000,
      lateArrivalPolicy: "drop",
      bestEffort: false,
    }
  );
}
