/**
 * Market-Hours and Calendar-Aware Feed Scheduling, Freshness, and Plausibility Evaluator (Issue #291)
 *
 * Uses IANA timezone resolution via Intl.DateTimeFormat to accurately handle DST transitions
 * (spring-forward / fall-back), weekends, exchange holidays, and scheduled quiet windows.
 */

export interface ActiveSessionWindow {
  /** ISO day of week: 0 = Sunday, 1 = Monday, ..., 6 = Saturday */
  daysOfWeek: number[];
  /** Start minute of local day (0..1439), e.g. 9*60 + 30 = 570 for 09:30 */
  startMinuteOfDay: number;
  /** End minute of local day (1..1440), e.g. 16*60 = 960 for 16:00 */
  endMinuteOfDay: number;
}

export interface FeedMarketCalendarConfig {
  feedId: string;
  /** IANA timezone identifier, e.g. "America/New_York" or "UTC" */
  timeZone: string;
  /** Whether the feed is continuous 24/7 (like crypto spot) or session-bound */
  continuous24x7?: boolean;
  /** Active session windows in local timezone */
  activeWindows: ActiveSessionWindow[];
  /** Local dates in YYYY-MM-DD format that are exchange/market holidays */
  holidays: string[];
  /** Maximum allowed age of a reading during active market hours (ms) */
  activeFreshnessWindowMs: number;
  /** Additional grace period before firing an unexpected-halt alert during active hours (ms) */
  unexpectedHaltGracePeriodMs: number;
  /** Whether flatline / zero-variance plausibility checks are suspended during quiet periods */
  suspendFlatlineCheckInQuietPeriod?: boolean;
}

export type MarketActivityState =
  | "active_session"
  | "quiet_weekend"
  | "quiet_holiday"
  | "quiet_off_hours";

export type PlausibilityCheckMode = "enforced" | "suspended_quiet_period";

export interface CalendarEvaluationResult {
  feedId: string;
  evaluatedAtMs: number;
  localDateIso: string; // YYYY-MM-DD in feed's IANA timeZone
  localDayOfWeek: number; // 0..6
  localMinuteOfDay: number; // 0..1439
  activityState: MarketActivityState;
  isExpectedActive: boolean;
  accruesStalenessPenalty: boolean;
  isStale: boolean;
  unexpectedHaltAlert: boolean;
  plausibilityCheckMode: PlausibilityCheckMode;
  metricLabels: {
    feed_id: string;
    activity_state: MarketActivityState;
    plausibility_mode: PlausibilityCheckMode;
  };
}

interface LocalTimeParts {
  localDateIso: string;
  dayOfWeek: number;
  minuteOfDay: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export class MarketCalendarResolver {
  private readonly configs = new Map<string, FeedMarketCalendarConfig>();
  private readonly formatters = new Map<string, Intl.DateTimeFormat>();
  private readonly minuteCache = new Map<string, LocalTimeParts>();

  registerFeedCalendar(config: FeedMarketCalendarConfig): void {
    if (!config.feedId || config.feedId.trim() === "") {
      throw new Error("feedId must be non-empty");
    }
    if (config.activeFreshnessWindowMs <= 0) {
      throw new Error(`Feed ${config.feedId}: activeFreshnessWindowMs must be positive`);
    }
    if (config.unexpectedHaltGracePeriodMs < 0) {
      throw new Error(`Feed ${config.feedId}: unexpectedHaltGracePeriodMs cannot be negative`);
    }
    // Fail-safe startup validation of IANA timeZone
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: config.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      this.formatters.set(config.timeZone, fmt);
    } catch {
      throw new Error(
        `Feed ${config.feedId}: invalid or unavailable IANA timeZone "${config.timeZone}"`
      );
    }

    this.configs.set(config.feedId, {
      ...config,
      holidays: [...config.holidays],
      activeWindows: config.activeWindows.map((w) => ({
        ...w,
        daysOfWeek: [...w.daysOfWeek],
      })),
    });
  }

  /**
   * Evaluates market activity state, freshness/staleness, unexpected halt alerts,
   * and plausibility check suspension at `nowMs` given `lastReadingAtMs`.
   */
  evaluateFeedAt(
    feedId: string,
    nowMs: number,
    lastReadingAtMs: number | null
  ): CalendarEvaluationResult {
    const config = this.configs.get(feedId);
    if (!config) {
      // Fail-safe: unknown calendar config defaults to enforcing checks rather than silently opening
      throw new Error(`No market calendar registered for feed "${feedId}"`);
    }

    const local = this.resolveLocalTimeParts(config.timeZone, nowMs);
    let activityState: MarketActivityState = "active_session";

    if (!config.continuous24x7) {
      if (config.holidays.includes(local.localDateIso)) {
        activityState = "quiet_holiday";
      } else {
        const anyWindowMatchesDay = config.activeWindows.some((w) =>
          w.daysOfWeek.includes(local.dayOfWeek)
        );
        if (!anyWindowMatchesDay) {
          activityState = "quiet_weekend";
        } else {
          const inTimeWindow = config.activeWindows.some(
            (w) =>
              w.daysOfWeek.includes(local.dayOfWeek) &&
              local.minuteOfDay >= w.startMinuteOfDay &&
              local.minuteOfDay < w.endMinuteOfDay
          );
          activityState = inTimeWindow ? "active_session" : "quiet_off_hours";
        }
      }
    }

    const isExpectedActive = activityState === "active_session";
    const accruesStalenessPenalty = isExpectedActive;

    const elapsedMs =
      lastReadingAtMs === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, nowMs - lastReadingAtMs);

    const isStale =
      isExpectedActive && elapsedMs > config.activeFreshnessWindowMs;
    const unexpectedHaltAlert =
      isExpectedActive &&
      elapsedMs >
        config.activeFreshnessWindowMs + config.unexpectedHaltGracePeriodMs;

    const suspendFlatline = config.suspendFlatlineCheckInQuietPeriod ?? true;
    const plausibilityCheckMode: PlausibilityCheckMode =
      !isExpectedActive && suspendFlatline
        ? "suspended_quiet_period"
        : "enforced";

    return {
      feedId,
      evaluatedAtMs: nowMs,
      localDateIso: local.localDateIso,
      localDayOfWeek: local.dayOfWeek,
      localMinuteOfDay: local.minuteOfDay,
      activityState,
      isExpectedActive,
      accruesStalenessPenalty,
      isStale,
      unexpectedHaltAlert,
      plausibilityCheckMode,
      metricLabels: {
        feed_id: feedId,
        activity_state: activityState,
        plausibility_mode: plausibilityCheckMode,
      },
    };
  }

  private resolveLocalTimeParts(timeZone: string, epochMs: number): LocalTimeParts {
    const minuteBucket = Math.floor(epochMs / 60_000);
    const cacheKey = `${timeZone}:${minuteBucket}`;
    const cached = this.minuteCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const fmt = this.formatters.get(timeZone)!;
    const parts = fmt.formatToParts(new Date(epochMs));
    let year = "";
    let month = "";
    let day = "";
    let weekday = "Mon";
    let hour = 0;
    let minute = 0;

    for (const p of parts) {
      if (p.type === "year") year = p.value;
      else if (p.type === "month") month = p.value;
      else if (p.type === "day") day = p.value;
      else if (p.type === "weekday") weekday = p.value;
      else if (p.type === "hour") {
        const parsedHour = Number.parseInt(p.value, 10);
        hour = parsedHour === 24 ? 0 : parsedHour;
      } else if (p.type === "minute") {
        minute = Number.parseInt(p.value, 10);
      }
    }

    const resolved: LocalTimeParts = {
      localDateIso: `${year}-${month}-${day}`,
      dayOfWeek: WEEKDAY_MAP[weekday] ?? 1,
      minuteOfDay: hour * 60 + minute,
    };
    this.minuteCache.set(cacheKey, resolved);
    return resolved;
  }
}
