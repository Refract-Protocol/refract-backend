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

/** Smallest window duration that can ever accumulate readings before closing. */
export const MIN_WINDOW_DURATION_MS = 1;

/**
 * Rejects a zero-length or negative window at the boundary where configs
 * enter the windowing system, naming the offending field. A window with
 * duration <= 0 would never close (or would close before any reading could
 * arrive), silently stalling the feed — see issue #579.
 */
export function assertValidFeedWindowConfig(config: FeedWindowConfig): FeedWindowConfig {
  if (!Number.isFinite(config.windowDurationMs) || config.windowDurationMs < MIN_WINDOW_DURATION_MS) {
    throw new Error(
      `FeedWindowConfig.windowDurationMs must be >= ${MIN_WINDOW_DURATION_MS}ms for feed "${config.feedId}", got ${config.windowDurationMs}`,
    );
  }
  return config;
}

/** Looks up a feed config, falling back to a default 30s window. */
export function getFeedConfig(
  feedId: string,
  configs: FeedWindowConfig[] = DEFAULT_FEED_WINDOW_CONFIGS,
): FeedWindowConfig {
  const config =
    configs.find((c) => c.feedId === feedId) ?? {
      feedId,
      windowDurationMs: 30_000,
      allowedLatenessMs: 5_000,
      lateArrivalPolicy: "drop",
      bestEffort: false,
    };
  return assertValidFeedWindowConfig(config);
}
