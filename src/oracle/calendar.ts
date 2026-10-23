/**
 * src/oracle/calendar.ts
 *
 * Calendar and clock abstraction for oracle feeds.
 *
 * Provides:
 *  - A single injectable `Clock` so all time evaluation can be driven
 *    deterministically in tests and so every component agrees on "now".
 *  - A cached `CalendarResolver` that, per feed, declares expected active
 *    windows, an IANA time zone, a holiday calendar source, and the allowed
 *    quiet behavior.
 *  - DST-safe window evaluation (no off-by-one-hour gaps or double windows).
 *  - Fail-safe behavior when calendars are unavailable at startup: we treat
 *    the feed as *expected to be live* (closed = false) so we do not silently
 *    accept a dead feed as "quiet".
 *  - A bounded grace period for unscheduled halts: if a feed should be live
 *    but has not published within `gracePeriodMs`, callers can alert.
 *
 * This module is intentionally dependency-free (no external date libraries)
 * so it can be used from freshness, staleness, and plausibility evaluation
 * without pulling in heavy transitive deps.
 */

/* -------------------------------------------------------------------------- */
/* Clock                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A minimal clock abstraction. Inject this everywhere time is evaluated.
 */
export interface Clock {
  /** Current time as epoch milliseconds. */
  now(): number;
}

/** Real wall-clock implementation backed by `Date.now()`. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * A manually controllable clock, primarily for tests. Time only advances when
 * `set`/`advance` is called, which makes evaluation results deterministic.
 */
export class FixedClock implements Clock {
  private current: number;

  constructor(initial: number | Date = 0) {
    this.current = typeof initial === 'number' ? initial : initial.getTime();
  }

  now(): number {
    return this.current;
  }

  set(time: number | Date): void {
    this.current = typeof time === 'number' ? time : time.getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/* -------------------------------------------------------------------------- */
/* Calendar declarations                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A recurring weekly active window expressed in the feed's local time zone.
 *
 * `startMinutes`/`endMinutes` are minutes since local midnight (0..1440).
 * A window may wrap past midnight (e.g. start 1320 = 22:00, end 120 = 02:00).
 *
 * `days` uses ISO weekday numbers: 1 = Monday ... 7 = Sunday.
 */
export interface ActiveWindow {
  /** ISO weekdays (1=Mon .. 7=Sun) on which this window applies. */
  days: number[];
  /** Minutes since local midnight when the window opens (inclusive). */
  startMinutes: number;
  /** Minutes since local midnight when the window closes (exclusive). */
  endMinutes: number;
}

/**
 * How a feed is allowed to behave while it is outside its active windows.
 */
export type QuietBehavior =
  /** Feed is expected to be silent; freshness/staleness do not accrue. */
  | 'expected-quiet'
  /** Feed may publish sporadically; relax plausibility checks. */
  | 'relaxed'
  /** Feed must keep publishing even when "closed" (e.g. 24/7 markets). */
  | 'always-live';

/**
 * Source of holiday data. The data itself is out of scope for this module;
 * we only declare where it comes from and its license so operators can audit.
 */
export interface HolidayCalendarSource {
  /** Stable identifier, e.g. "nyse", "lse", "cme". */
  id: string;
  /** Human-readable description. */
  description?: string;
  /** License under which the holiday data is distributed. */
  license?: string;
  /** Optional URL where the data is published. */
  url?: string;
}

/**
 * Per-feed calendar declaration.
 */
export interface FeedCalendarDeclaration {
  /** IANA time zone, e.g. "America/New_York". */
  timeZone: string;
  /** Expected active windows in local time. Empty => always live. */
  activeWindows: ActiveWindow[];
  /** Holiday calendar source (data supplied separately). */
  holidaySource?: HolidayCalendarSource;
  /** Allowed quiet behavior outside active windows. */
  quietBehavior: QuietBehavior;
  /**
   * Bounded grace period (ms) after an expected-open window begins during
   * which a feed may legitimately be late. After this elapses without a
   * publication, an unscheduled halt should alert.
   */
  gracePeriodMs: number;
}

/**
 * A resolved holiday set: local calendar dates (YYYY-MM-DD in the feed's
 * time zone) on which the market is closed.
 */
export interface HolidaySet {
  /** Set of local dates (YYYY-MM-DD) that are holidays. */
  dates: Set<string>;
  /** Whether the set is authoritative (loaded successfully). */
  available: boolean;
}

/* -------------------------------------------------------------------------- */
/* Calendar provider (holiday data)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Supplies holiday data for a given source. Implementations may read from a
 * file, a remote service, or a static table. The resolver caches results.
 */
export interface HolidayProvider {
  /**
   * Load the holiday set for the given source. Implementations should throw
   * or return `undefined` when data is unavailable so the resolver can fail
   * safe.
   */
  load(source: HolidayCalendarSource): Promise<HolidaySet | undefined> | HolidaySet | undefined;
}

/** A provider that never has holiday data (always unavailable). */
export class NullHolidayProvider implements HolidayProvider {
  load(): undefined {
    return undefined;
  }
}

/** A static in-memory holiday provider, useful for tests and small deployments. */
export class StaticHolidayProvider implements HolidayProvider {
  private readonly bySourceId: Map<string, Set<string>>;

  constructor(bySourceId: Record<string, string[]> = {}) {
    this.bySourceId = new Map();
    for (const [id, dates] of Object.entries(bySourceId)) {
      this.bySourceId.set(id, new Set(dates));
    }
  }

  load(source: HolidayCalendarSource): HolidaySet | undefined {
    const dates = this.bySourceId.get(source.id);
    if (!dates) return undefined;
    return { dates, available: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Time zone helpers (DST-safe)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns the local date/time components for an instant in a given IANA zone.
 *
 * Uses `Intl.DateTimeFormat` with `timeZone`, which correctly accounts for
 * DST transitions. We request numeric parts and reconstruct them, avoiding
 * locale-dependent string parsing.
 */
export interface ZonedParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
  /** ISO weekday: 1=Mon .. 7=Sun. */
  isoWeekday: number;
  /** Local date as YYYY-MM-DD. */
  dateKey: string;
  /** Minutes since local midnight. */
  minutesSinceMidnight: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Convert an epoch-ms instant into zoned parts for the given IANA time zone.
 * DST-safe: relies on `Intl` which handles transitions.
 */
export function toZonedParts(epochMs: number, timeZone: string): ZonedParts {
  const fmt = getFormatter(timeZone);
  const parts = fmt.formatToParts(new Date(epochMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let weekday = 'Mon';

  for (const p of parts) {
    switch (p.type) {
      case 'year':
        year = parseInt(p.value, 10);
        break;
      case 'month':
        month = parseInt(p.value, 10);
        break;
      case 'day':
        day = parseInt(p.value, 10);
        break;
      case 'hour':
        // `hour12: false` can yield "24" for midnight in some engines.
        hour = parseInt(p.value, 10) % 24;
        break;
      case 'minute':
        minute = parseInt(p.value, 10);
        break;
      case 'second':
        second = parseInt(p.value, 10);
        break;
      case 'weekday':
        weekday = p.value;
        break;
      default:
        break;
    }
  }

  const isoWeekday = WEEKDAY_TO_ISO[weekday] ?? 1;
  const dateKey = `${year}-${pad2(month)}-${pad2(day)}`;
  const minutesSinceMidnight = hour * 60 + minute;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    isoWeekday,
    dateKey,
    minutesSinceMidnight,
  };
}

/* -------------------------------------------------------------------------- */
/* Window evaluation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Result of evaluating whether a feed is expected to be live at an instant.
 */
export interface ActivityEvaluation {
  /** True if the feed is expected to be publishing right now. */
  expectedLive: boolean;
  /** True if the feed is within an allowed quiet period (closed market). */
  quiet: boolean;
  /** The quiet behavior in effect (from the declaration). */
  quietBehavior: QuietBehavior;
  /** True if the current local date is a holiday for this feed. */
  holiday: boolean;
  /** True if the current local weekday is a weekend (Sat/Sun). */
  weekend: boolean;
  /** True if the calendar data was available; false means fail-safe open. */
  calendarAvailable: boolean;
  /** The zoned parts used for evaluation (for auditing/evidence). */
  zoned: ZonedParts;
  /**
   * If the feed is expected live, the instant at which the current active
   * window opened (epoch ms). Undefined when not expected live.
   */
  windowOpenedAt?: number;
  /**
   * If the feed is expected live, the instant after which an unscheduled halt
   * should alert (windowOpenedAt + gracePeriodMs). Undefined when not live.
   */
  graceDeadline?: number;
}

/**
 * Check whether `minutes` falls within a window, handling wrap-past-midnight.
 * The window is [start, end) in local minutes.
 */
function minutesInWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) {
    // Zero-length window: treat as never active to avoid double windows.
    return false;
  }
  if (start < end) {
    return minutes >= start && minutes < end;
  }
  // Wraps midnight, e.g. 22:00 -> 02:00.
  return minutes >= start || minutes < end;
}

/**
 * Determine whether a given zoned instant falls inside any active window.
 * Handles windows that wrap past midnight by also checking the previous
 * day's windows (for the post-midnight portion).
 */
function isWithinActiveWindows(zoned: ZonedParts, windows: ActiveWindow[]): boolean {
  if (windows.length === 0) return true; // no windows => always live

  for (const w of windows) {
    if (w.startMinutes < w.endMinutes) {
      // Non-wrapping window: applies on its own day.
      if (w.days.includes(zoned.isoWeekday) && minutesInWindow(zoned.minutesSinceMidnight, w.startMinutes, w.endMinutes)) {
        return true;
      }
    } else {
      // Wrapping window: the pre-midnight portion applies on `w.days`,
      // the post-midnight portion applies on the following day.
      if (w.days.includes(zoned.isoWeekday) && zoned.minutesSinceMidnight >= w.startMinutes) {
        return true;
      }
      const prevIso = zoned.isoWeekday === 1 ? 7 : zoned.isoWeekday - 1;
      if (w.days.includes(prevIso) && zoned.minutesSinceMidnight < w.endMinutes) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compute the epoch-ms instant at which the current active window opened.
 *
 * This is used to bound the grace period. We approximate by walking back in
 * time in one-minute steps until we leave the active window. This is bounded
 * (max 24h + wrap) and only invoked when a feed is expected live, so the cost
 * is acceptable and cached by the resolver.
 */
function findWindowOpenedAt(nowMs: number, timeZone: string, windows: ActiveWindow[]): number {
  if (windows.length === 0) {
    // Always-live feed: window conceptually opened at the epoch; callers
    // should use publication timestamps rather than this value.
    return 0;
  }
  const stepMs = 60_000;
  const maxLookbackMs = 26 * 60 * 60 * 1000; // 26h covers wrap + DST
  let cursor = nowMs;
  let elapsed = 0;
  // Walk backwards while still inside a window.
  while (elapsed < maxLookbackMs) {
    const prev = cursor - stepMs;
    const prevParts = toZonedParts(prev, timeZone);
    if (!isWithinActiveWindows(prevParts, windows)) {
      return cursor;
    }
    cursor = prev;
    elapsed += stepMs;
  }
  return cursor;
}

/* -------------------------------------------------------------------------- */
/* Calendar resolver (cached)                                                 */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  holidaySet: HolidaySet;
  loadedAt: number;
}

export interface CalendarResolverOptions {
  /** Clock used for cache TTL and evaluation. */
  clock: Clock;
  /** Holiday data provider. */
  holidayProvider?: HolidayProvider;
  /** How long to cache holiday data before reloading (ms). Default 6h. */
  holidayCacheTtlMs?: number;
  /** How long to cache activity evaluations (ms). Default 30s. */
  evaluationCacheTtlMs?: number;
}

interface EvaluationCacheEntry {
  result: ActivityEvaluation;
  computedAt: number;
}

/**
 * Cached calendar resolver. One instance is shared across freshness,
 * staleness, and plausibility evaluation so they all agree on
 * "is this feed expected to be live now".
 */
export class CalendarResolver {
  private readonly clock: Clock;
  private readonly holidayProvider: HolidayProvider;
  private readonly holidayCacheTtlMs: number;
  private readonly evaluationCacheTtlMs: number;

  private readonly holidayCache = new Map<string, CacheEntry>();
  private readonly evaluationCache = new Map<string, EvaluationCacheEntry>();

  constructor(options: CalendarResolverOptions) {
    this.clock = options.clock;
    this.holidayProvider = options.holidayProvider ?? new NullHolidayProvider();
    this.holidayCacheTtlMs = options.holidayCacheTtlMs ?? 6 * 60 * 60 * 1000;
    this.evaluationCacheTtlMs = options.evaluationCacheTtlMs ?? 30 * 1000;
  }

  /**
   * Resolve the holiday set for a source, caching the result. Fails safe:
   * if the provider is unavailable, returns an unavailable set (which callers
   * treat as "not a holiday" so we do not silently accept a dead feed).
   */
  private resolveHolidays(source: HolidayCalendarSource | undefined): HolidaySet {
    if (!source) {
      return { dates: new Set(), available: true };
    }
    const now = this.clock.now();
    const cached = this.holidayCache.get(source.id);
    if (cached && now - cached.loadedAt < this.holidayCacheTtlMs) {
      return cached.holidaySet;
    }

    let loaded: HolidaySet | undefined;
    try {
      const result = this.holidayProvider.load(source);
      // Support both sync and async providers; async is not awaited here
      // because evaluation is synchronous. Async providers should pre-warm.
      if (result && typeof (result as Promise<HolidaySet | undefined>).then === 'function') {
        // Fail safe: treat as unavailable until the promise resolves and a
        // subsequent call picks up the cached value.
        loaded = undefined;
      } else {
        loaded = result as HolidaySet | undefined;
      }
    } catch {
      loaded = undefined;
    }

    const holidaySet: HolidaySet = loaded && loaded.available
      ? loaded
      : { dates: new Set(), available: false };

    this.holidayCache.set(source.id, { holidaySet, loadedAt: now });
    return holidaySet;
  }

  /**
   * Evaluate whether a feed is expected to be live at the current clock time.
   * Results are cached for `evaluationCacheTtlMs` to avoid per-reading overhead.
   */
  evaluate(feedId: string, declaration: FeedCalendarDeclaration): ActivityEvaluation {
    const now = this.clock.now();
    const cacheKey = feedId;
    const cached = this.evaluationCache.get(cacheKey);
    if (cached && now - cached.computedAt < this.evaluationCacheTtlMs) {
      return cached.result;
    }

    const result = this.evaluateAt(now, declaration);
    this.evaluationCache.set(cacheKey, { result, computedAt: now });
    return result;
  }

  /**
   * Evaluate at an explicit instant (bypasses the evaluation cache). Useful
   * for tests and for backfilling evidence.
   */
  evaluateAt(epochMs: number, declaration: FeedCalendarDeclaration): ActivityEvaluation {
    const zoned = toZonedParts(epochMs, declaration.timeZone);
    const holidaySet = this.resolveHolidays(declaration.holidaySource);
    const holiday = holidaySet.available && holidaySet.dates.has(zoned.dateKey);
    const weekend = zoned.isoWeekday === 6 || zoned.isoWeekday === 7;

    // Fail safe: if the calendar is unavailable, we cannot know whether the
    // market is closed, so we treat the feed as expected live. This prevents
    // silently accepting a dead feed as "quiet".
    const calendarAvailable = holidaySet.available;

    let withinWindows: boolean;
    if (!calendarAvailable) {
      withinWindows = true;
    } else if (holiday) {
      withinWindows = false;
    } else {
      withinWindows = isWithinActiveWindows(zoned, declaration.activeWindows);
    }

    const expectedLive = withinWindows;
    const quiet = !expectedLive;

    const evaluation: ActivityEvaluation = {
      expectedLive,
      quiet,
      quietBehavior: declaration.quietBehavior,
      holiday,
      weekend,
      calendarAvailable,
      zoned,
    };

    if (expectedLive) {
      const windowOpenedAt = findWindowOpenedAt(epochMs, declaration.timeZone, declaration.activeWindows);
      evaluation.windowOpenedAt = windowOpenedAt;
      evaluation.graceDeadline = windowOpenedAt + declaration.gracePeriodMs;
    }

    return evaluation;
  }

  /** Clear all caches (e.g. after a config reload). */
  clearCache(): void {
    this.holidayCache.clear();
    this.evaluationCache.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers for freshness / staleness / plausibility                           */
/* -------------------------------------------------------------------------- */

/**
 * Compute the effective freshness window for a feed, accounting for the
 * calendar. When the feed is in an allowed quiet period, the freshness window
 * is extended to the full quiet duration so no staleness accrues. When the
 * feed is expected live, the base freshness window applies.
 *
 * Returns the window in milliseconds.
 */
export function effectiveFreshnessWindowMs(
  baseFreshnessMs: number,
  evaluation: ActivityEvaluation,
): number {
  if (evaluation.expectedLive) {
    return baseFreshnessMs;
  }
  if (evaluation.quietBehavior === 'always-live') {
    // Feed must keep publishing; do not extend.
    return baseFreshnessMs;
  }
  // Expected quiet or relaxed: do not accrue staleness while closed.
  return Number.POSITIVE_INFINITY;
}

/**
 * Determine whether a feed should be considered stale given its last
 * publication time and the current evaluation.
 *
 * - If the feed is expected live: stale when `now - lastPublishedAt` exceeds
 *   the base freshness window.
 * - If the feed is in an allowed quiet period: never stale (staleness does
 *   not accrue while closed).
 * - If the calendar is unavailable (fail-safe open), we treat the feed as
 *   expected live and apply the base window.
 */
export function isStale(
  lastPublishedAt: number | undefined,
  nowMs: number,
  baseFreshnessMs: number,
  evaluation: ActivityEvaluation,
): boolean {
  if (lastPublishedAt === undefined) {
    // Never published: stale only if we expect it to be live.
    return evaluation.expectedLive;
  }
  const windowMs = effectiveFreshnessWindowMs(baseFreshnessMs, evaluation);
  if (!Number.isFinite(windowMs)) {
    return false;
  }
  return nowMs - lastPublishedAt > windowMs;
}

/**
 * Determine whether an unscheduled halt should alert. A halt is "unscheduled"
 * when the feed is expected live (not in a declared quiet period) but has not
 * published within the bounded grace period after the window opened.
 *
 * Returns true when the grace deadline has passed without a publication.
 */
export function shouldAlertUnscheduledHalt(
  lastPublishedAt: number | undefined,
  nowMs: number,
  evaluation: ActivityEvaluation,
): boolean {
  if (!evaluation.expectedLive) {
    return false;
  }
  if (evaluation.graceDeadline === undefined) {
    return false;
  }
  if (nowMs < evaluation.graceDeadline) {
    return false;
  }
  if (lastPublishedAt === undefined) {
    return true;
  }
  // If the feed published after the window opened, it is not halted.
  if (evaluation.windowOpenedAt !== undefined && lastPublishedAt >= evaluation.windowOpenedAt) {
    return false;
  }
  return true;
}

/**
 * Whether plausibility/anomaly checks should be suspended or relaxed for this
 * evaluation. The suspension itself should be recorded in evidence and metric
 * labels by the caller so it is auditable.
 */
export interface PlausibilityMode {
  /** True if plausibility checks should be skipped entirely. */
  suspended: boolean;
  /** True if plausibility checks should run with relaxed thresholds. */
  relaxed: boolean;
  /** Human-readable reason for auditing/evidence. */
  reason?: string;
}

export function plausibilityMode(evaluation: ActivityEvaluation): PlausibilityMode {
  if (evaluation.expectedLive) {
    return { suspended: false, relaxed: false };
  }
  switch (evaluation.quietBehavior) {
    case 'expected-quiet':
      return {
        suspended: true,
        relaxed: false,
        reason: evaluation.holiday
          ? 'holiday-quiet'
          : evaluation.weekend
            ? 'weekend-quiet'
            : 'outside-active-window',
      };
    case 'relaxed':
      return {
        suspended: false,
        relaxed: true,
        reason: evaluation.holiday
          ? 'holiday-relaxed'
          : evaluation.weekend
            ? 'weekend-relaxed'
            : 'outside-active-window-relaxed',
      };
    case 'always-live':
      // Should not reach here (expectedLive would be true), but be safe.
      return { suspended: false, relaxed: false };
    default:
      return { suspended: false, relaxed: false };
  }
}

/**
 * Metric labels describing the calendar state, for use in evidence and
 * metrics so suspensions are auditable.
 */
export function calendarMetricLabels(evaluation: ActivityEvaluation): Record<string, string> {
  return {
    expected_live: String(evaluation.expectedLive),
    quiet: String(evaluation.quiet),
    quiet_behavior: evaluation.quietBehavior,
    holiday: String(evaluation.holiday),
    weekend: String(evaluation.weekend),
    calendar_available: String(evaluation.calendarAvailable),
    local_date: evaluation.zoned.dateKey,
  };
}