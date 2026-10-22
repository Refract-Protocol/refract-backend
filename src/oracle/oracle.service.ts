import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  OracleServiceConfig,
  OracleFeed,
  OracleReading,
  OracleSubmission,
  OracleSource,
  OracleAlert,
  OracleAlertSeverity,
  OracleAlertType,
  OracleMetrics,
  OracleEvidence,
  OracleEvidenceKind,
  FreshnessEvaluation,
  StalenessEvaluation,
  PlausibilityEvaluation,
  PlausibilityStatus,
  FeedActivityState,
  FeedCalendarDeclaration,
  AttestationTier,
} from './types';
import { OracleError, OracleErrorCode } from './errors';
import { CalendarResolver } from './calendar/calendar-resolver';
import { Clock } from './calendar/clock';
import { AttestationVerifier } from './attestation/attestation-verifier';
import { SourceIndependencePolicy } from './attestation/source-independence-policy';

/**
 * OracleService
 *
 * Central orchestration for oracle feed ingestion, freshness/staleness
 * evaluation, plausibility checks, and alerting.
 *
 * Time is always evaluated through the injected {@link Clock} and feed
 * activity is always resolved through the injected {@link CalendarResolver}
 * so that:
 *   - tests can freeze time deterministically, and
 *   - freshness/staleness/plausibility respect market hours, holidays,
 *     DST transitions, and scheduled quiet periods.
 */
export class OracleService extends EventEmitter {
  private readonly config: OracleServiceConfig;
  private readonly clock: Clock;
  private readonly calendarResolver: CalendarResolver;
  private readonly attestationVerifier?: AttestationVerifier;
  private readonly independencePolicy?: SourceIndependencePolicy;

  private readonly feeds: Map<string, OracleFeed> = new Map();
  private readonly readings: Map<string, OracleReading[]> = new Map();
  private readonly alerts: Map<string, OracleAlert> = new Map();
  private readonly evidence: OracleEvidence[] = [];
  private readonly metrics: OracleMetrics;

  /**
   * Tracks the last time we observed a feed that *should* have been
   * publishing but was not. Used to bound unscheduled-halt alerting.
   */
  private readonly unscheduledHaltSince: Map<string, number> = new Map();

  constructor(
    config: OracleServiceConfig,
    clock: Clock,
    calendarResolver: CalendarResolver,
    attestationVerifier?: AttestationVerifier,
    independencePolicy?: SourceIndependencePolicy,
  ) {
    super();
    this.config = config;
    this.clock = clock;
    this.calendarResolver = calendarResolver;
    this.attestationVerifier = attestationVerifier;
    this.independencePolicy = independencePolicy;

    this.metrics = {
      readingsIngested: 0,
      readingsRejected: 0,
      alertsRaised: 0,
      freshnessEvaluations: 0,
      stalenessEvaluations: 0,
      plausibilityEvaluations: 0,
      plausibilitySuspended: 0,
      unscheduledHaltAlerts: 0,
      attestationVerified: 0,
      attestationFailed: 0,
      byFeed: {},
    };
  }

  // ---------------------------------------------------------------------------
  // Feed registration
  // ---------------------------------------------------------------------------

  public registerFeed(feed: OracleFeed): void {
    if (this.feeds.has(feed.id)) {
      throw new OracleError(
        OracleErrorCode.FEED_ALREADY_REGISTERED,
        `Feed ${feed.id} is already registered`,
      );
    }
    this.feeds.set(feed.id, feed);
    this.readings.set(feed.id, []);
    this.metrics.byFeed[feed.id] = {
      readingsIngested: 0,
      readingsRejected: 0,
      alertsRaised: 0,
      lastReadingAt: null,
      lastFreshnessStatus: null,
      lastStalenessStatus: null,
      lastPlausibilityStatus: null,
      lastActivityState: null,
      plausibilitySuspended: 0,
      unscheduledHaltAlerts: 0,
    };
  }

  public getFeed(feedId: string): OracleFeed | undefined {
    return this.feeds.get(feedId);
  }

  public listFeeds(): OracleFeed[] {
    return Array.from(this.feeds.values());
  }

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------

  public async ingestReading(submission: OracleSubmission): Promise<OracleReading> {
    const feed = this.feeds.get(submission.feedId);
    if (!feed) {
      throw new OracleError(
        OracleErrorCode.FEED_NOT_FOUND,
        `Feed ${submission.feedId} is not registered`,
      );
    }

    const source = feed.sources.find((s) => s.id === submission.sourceId);
    if (!source) {
      throw new OracleError(
        OracleErrorCode.SOURCE_NOT_FOUND,
        `Source ${submission.sourceId} is not registered for feed ${feed.id}`,
      );
    }

    // Attestation is verified as a separate, independently testable step.
    let attestationTier: AttestationTier = AttestationTier.BASE;
    if (submission.attestation) {
      if (!this.attestationVerifier) {
        this.recordAttestationFailure(feed, source, submission, 'verifier_unavailable');
        throw new OracleError(
          OracleErrorCode.ATTESTATION_FAILED,
          'Attestation submitted but no verifier is configured',
        );
      }
      const result = await this.attestationVerifier.verify(submission, source);
      if (!result.valid) {
        this.recordAttestationFailure(feed, source, submission, result.reason);
        this.metrics.attestationFailed += 1;
        throw new OracleError(
          OracleErrorCode.ATTESTATION_FAILED,
          `Attestation verification failed: ${result.reason}`,
        );
      }
      attestationTier = result.tier;
      this.metrics.attestationVerified += 1;
    }

    const now = this.clock.now();
    const reading: OracleReading = {
      id: randomUUID(),
      feedId: feed.id,
      sourceId: source.id,
      value: submission.value,
      observedAt: submission.observedAt,
      receivedAt: now,
      attestationTier,
      metadata: submission.metadata ?? {},
    };

    const feedReadings = this.readings.get(feed.id)!;
    feedReadings.push(reading);
    if (feedReadings.length > this.config.maxReadingsPerFeed) {
      feedReadings.splice(0, feedReadings.length - this.config.maxReadingsPerFeed);
    }

    this.metrics.readingsIngested += 1;
    this.metrics.byFeed[feed.id].readingsIngested += 1;
    this.metrics.byFeed[feed.id].lastReadingAt = now;

    // A reading arrived, so any pending unscheduled-halt tracking clears.
    this.unscheduledHaltSince.delete(feed.id);

    this.emit('reading', reading);
    return reading;
  }

  private recordAttestationFailure(
    feed: OracleFeed,
    source: OracleSource,
    submission: OracleSubmission,
    reason: string,
  ): void {
    this.addEvidence({
      id: randomUUID(),
      kind: OracleEvidenceKind.ATTESTATION_FAILURE,
      feedId: feed.id,
      sourceId: source.id,
      recordedAt: this.clock.now(),
      details: {
        reason,
        teeType: submission.attestation?.teeType ?? null,
        nonce: submission.attestation?.nonce ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Calendar-aware activity resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve whether the feed is expected to be active at the given instant,
   * using the feed's calendar declaration. If the calendar is unavailable we
   * fail safe: treat the feed as expected-active so that we do not silently
   * accept a down feed as "quiet".
   */
  public resolveActivityState(feed: OracleFeed, at: number = this.clock.now()): FeedActivityState {
    const declaration: FeedCalendarDeclaration | undefined = feed.calendar;
    if (!declaration) {
      // No calendar declared: assume continuous 24/7 activity.
      return {
        feedId: feed.id,
        at,
        expectedActive: true,
        quietReason: null,
        calendarAvailable: true,
        timeZone: null,
      };
    }

    try {
      const resolved = this.calendarResolver.resolve(declaration, at);
      return {
        feedId: feed.id,
        at,
        expectedActive: resolved.expectedActive,
        quietReason: resolved.quietReason,
        calendarAvailable: true,
        timeZone: resolved.timeZone,
      };
    } catch (err) {
      // Fail safe, not silently open: treat as expected-active so that a
      // genuinely down feed still accrues staleness and alerts.
      this.addEvidence({
        id: randomUUID(),
        kind: OracleEvidenceKind.CALENDAR_UNAVAILABLE,
        feedId: feed.id,
        sourceId: null,
        recordedAt: this.clock.now(),
        details: {
          error: err instanceof Error ? err.message : String(err),
          declaration,
        },
      });
      return {
        feedId: feed.id,
        at,
        expectedActive: true,
        quietReason: 'calendar_unavailable',
        calendarAvailable: false,
        timeZone: declaration.timeZone ?? null,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Freshness / staleness evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate freshness against the feed calendar. While the feed is in a
   * declared quiet window, elapsed time does not accrue against the freshness
   * window. When the feed is expected to be active, elapsed time counts fully.
   */
  public evaluateFreshness(feedId: string, at: number = this.clock.now()): FreshnessEvaluation {
    const feed = this.requireFeed(feedId);
    const activity = this.resolveActivityState(feed, at);
    const lastReading = this.getLatestReading(feedId);

    this.metrics.freshnessEvaluations += 1;

    if (!lastReading) {
      const status = activity.expectedActive ? 'stale' : 'quiet';
      this.metrics.byFeed[feedId].lastFreshnessStatus = status;
      this.metrics.byFeed[feedId].lastActivityState = activity;
      return {
        feedId,
        evaluatedAt: at,
        status,
        lastReadingAt: null,
        effectiveAgeMs: null,
        freshnessWindowMs: feed.freshnessWindowMs,
        activity,
        suspended: !activity.expectedActive,
      };
    }

    const effectiveAgeMs = this.computeEffectiveAgeMs(feed, lastReading.receivedAt, at, activity);

    let status: FreshnessEvaluation['status'];
    if (!activity.expectedActive) {
      // Quiet period: do not accrue staleness. Only flag if the reading is
      // older than the window *plus* the quiet duration (i.e. it was already
      // stale before the quiet window began).
      status = effectiveAgeMs > feed.freshnessWindowMs ? 'stale' : 'quiet';
    } else {
      status = effectiveAgeMs > feed.freshnessWindowMs ? 'stale' : 'fresh';
    }

    this.metrics.byFeed[feedId].lastFreshnessStatus = status;
    this.metrics.byFeed[feedId].lastActivityState = activity;

    const evaluation: FreshnessEvaluation = {
      feedId,
      evaluatedAt: at,
      status,
      lastReadingAt: lastReading.receivedAt,
      effectiveAgeMs,
      freshnessWindowMs: feed.freshnessWindowMs,
      activity,
      suspended: !activity.expectedActive,
    };

    if (status === 'stale' && activity.expectedActive) {
      this.handleUnscheduledHalt(feed, at, effectiveAgeMs);
    } else {
      this.unscheduledHaltSince.delete(feed.id);
    }

    return evaluation;
  }

  /**
   * Evaluate staleness. Staleness is the complement of freshness but is
   * evaluated separately so that callers can distinguish "closed market"
   * from "feed is down".
   */
  public evaluateStaleness(feedId: string, at: number = this.clock.now()): StalenessEvaluation {
    const feed = this.requireFeed(feedId);
    const activity = this.resolveActivityState(feed, at);
    const lastReading = this.getLatestReading(feedId);

    this.metrics.stalenessEvaluations += 1;

    if (!lastReading) {
      const stale = activity.expectedActive;
      this.metrics.byFeed[feedId].lastStalenessStatus = stale ? 'stale' : 'quiet';
      return {
        feedId,
        evaluatedAt: at,
        stale,
        status: stale ? 'stale' : 'quiet',
        lastReadingAt: null,
        effectiveAgeMs: null,
        stalenessWindowMs: feed.stalenessWindowMs,
        activity,
        suspended: !activity.expectedActive,
      };
    }

    const effectiveAgeMs = this.computeEffectiveAgeMs(feed, lastReading.receivedAt, at, activity);
    const stale = effectiveAgeMs > feed.stalenessWindowMs;

    let status: StalenessEvaluation['status'];
    if (!activity.expectedActive) {
      status = stale ? 'stale' : 'quiet';
    } else {
      status = stale ? 'stale' : 'ok';
    }

    this.metrics.byFeed[feedId].lastStalenessStatus = status;

    if (stale && activity.expectedActive) {
      this.handleUnscheduledHalt(feed, at, effectiveAgeMs);
    }

    return {
      feedId,
      evaluatedAt: at,
      stale,
      status,
      lastReadingAt: lastReading.receivedAt,
      effectiveAgeMs,
      stalenessWindowMs: feed.stalenessWindowMs,
      activity,
      suspended: !activity.expectedActive,
    };
  }

  /**
   * Compute the age of a reading, excluding time spent inside declared quiet
   * windows. This is what makes a closed market not accrue staleness while a
   * feed that should be publishing does.
   */
  private computeEffectiveAgeMs(
    feed: OracleFeed,
    lastReadingAt: number,
    at: number,
    activity: FeedActivityState,
  ): number {
    if (at <= lastReadingAt) {
      return 0;
    }

    // Fast path: no calendar, or currently active with no quiet history to
    // subtract. We still need to subtract any quiet windows that occurred
    // between lastReadingAt and `at`.
    if (!feed.calendar) {
      return at - lastReadingAt;
    }

    try {
      const quietMs = this.calendarResolver.quietDurationBetween(
        feed.calendar,
        lastReadingAt,
        at,
      );
      const total = at - lastReadingAt;
      const effective = total - quietMs;
      return effective < 0 ? 0 : effective;
    } catch (err) {
      // Calendar unavailable: fail safe by counting full elapsed time so a
      // genuinely down feed still alerts.
      this.addEvidence({
        id: randomUUID(),
        kind: OracleEvidenceKind.CALENDAR_UNAVAILABLE,
        feedId: feed.id,
        sourceId: null,
        recordedAt: this.clock.now(),
        details: {
          error: err instanceof Error ? err.message : String(err),
          context: 'computeEffectiveAgeMs',
        },
      });
      return at - lastReadingAt;
    }
  }

  /**
   * Unscheduled halt handling: a feed that should be publishing but is not
   * must alert after a bounded grace period. The grace period is configured
   * per-feed (or globally) and is measured in *active* time, so a halt that
   * begins just before a scheduled quiet window does not alert until the
   * market reopens and the grace period elapses in active time.
   */
  private handleUnscheduledHalt(feed: OracleFeed, at: number, effectiveAgeMs: number): void {
    const graceMs = feed.unscheduledHaltGraceMs ?? this.config.defaultUnscheduledHaltGraceMs;
    const threshold = feed.stalenessWindowMs + graceMs;

    if (effectiveAgeMs <= threshold) {
      return;
    }

    const since = this.unscheduledHaltSince.get(feed.id);
    if (since === undefined) {
      this.unscheduledHaltSince.set(feed.id, at);
    }

    const existing = this.findOpenAlert(feed.id, OracleAlertType.UNSCHEDULED_HALT);
    if (existing) {
      return;
    }

    this.metrics.unscheduledHaltAlerts += 1;
    this.metrics.byFeed[feed.id].unscheduledHaltAlerts += 1;

    this.raiseAlert({
      feedId: feed.id,
      type: OracleAlertType.UNSCHEDULED_HALT,
      severity: OracleAlertSeverity.CRITICAL,
      message: `Feed ${feed.id} expected to be active but has not published within grace period (effective age ${effectiveAgeMs}ms, threshold ${threshold}ms)`,
      details: {
        effectiveAgeMs,
        stalenessWindowMs: feed.stalenessWindowMs,
        graceMs,
        threshold,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Plausibility / anomaly evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate plausibility. During declared quiet periods, plausibility checks
   * are suspended (or relaxed per the feed's allowed quiet behavior). The
   * suspension is recorded both in evidence and in metric labels so it is
   * auditable.
   */
  public evaluatePlausibility(feedId: string, at: number = this.clock.now()): PlausibilityEvaluation {
    const feed = this.requireFeed(feedId);
    const activity = this.resolveActivityState(feed, at);
    const lastReading = this.getLatestReading(feedId);

    this.metrics.plausibilityEvaluations += 1;

    if (!activity.expectedActive) {
      const behavior = feed.calendar?.allowedQuietBehavior ?? 'suspend';
      const suspended = behavior === 'suspend';

      if (suspended) {
        this.metrics.plausibilitySuspended += 1;
        this.metrics.byFeed[feedId].plausibilitySuspended += 1;
      }

      this.addEvidence({
        id: randomUUID(),
        kind: OracleEvidenceKind.PLAUSIBILITY_SUSPENDED,
        feedId,
        sourceId: null,
        recordedAt: at,
        details: {
          quietReason: activity.quietReason,
          behavior,
          suspended,
          timeZone: activity.timeZone,
        },
      });

      const status: PlausibilityStatus = suspended
        ? PlausibilityStatus.SUSPENDED
        : PlausibilityStatus.RELAXED;

      this.metrics.byFeed[feedId].lastPlausibilityStatus = status;

      return {
        feedId,
        evaluatedAt: at,
        status,
        activity,
        suspended,
        relaxed: !suspended,
        reason: activity.quietReason,
        checks: [],
      };
    }

    if (!lastReading) {
      const status = PlausibilityStatus.UNKNOWN;
      this.metrics.byFeed[feedId].lastPlausibilityStatus = status;
      return {
        feedId,
        evaluatedAt: at,
        status,
        activity,
        suspended: false,
        relaxed: false,
        reason: 'no_reading',
        checks: [],
      };
    }

    const checks = this.runPlausibilityChecks(feed, lastReading, at);
    const failed = checks.filter((c) => !c.passed);
    const status = failed.length === 0 ? PlausibilityStatus.OK : PlausibilityStatus.FAILED;

    this.metrics.byFeed[feedId].lastPlausibilityStatus = status;

    if (status === PlausibilityStatus.FAILED) {
      this.raiseAlert({
        feedId,
        type: OracleAlertType.PLAUSIBILITY_FAILURE,
        severity: OracleAlertSeverity.WARNING,
        message: `Feed ${feedId} failed plausibility checks: ${failed.map((c) => c.name).join(', ')}`,
        details: { checks },
      });
    }

    return {
      feedId,
      evaluatedAt: at,
      status,
      activity,
      suspended: false,
      relaxed: false,
      reason: null,
      checks,
    };
  }

  private runPlausibilityChecks(
    feed: OracleFeed,
    reading: OracleReading,
    at: number,
  ): PlausibilityEvaluation['checks'] {
    const checks: PlausibilityEvaluation['checks'] = [];

    if (feed.plausibility?.minValue !== undefined) {
      checks.push({
        name: 'min_value',
        passed: reading.value >= feed.plausibility.minValue,
        details: { value: reading.value, min: feed.plausibility.minValue },
      });
    }

    if (feed.plausibility?.maxValue !== undefined) {
      checks.push({
        name: 'max_value',
        passed: reading.value <= feed.plausibility.maxValue,
        details: { value: reading.value, max: feed.plausibility.maxValue },
      });
    }

    if (feed.plausibility?.maxDeviationPct !== undefined) {
      const previous = this.getPreviousReading(feed.id, reading.id);
      if (previous && previous.value !== 0) {
        const deviationPct = Math.abs((reading.value - previous.value) / previous.value) * 100;
        checks.push({
          name: 'max_deviation_pct',
          passed: deviationPct <= feed.plausibility.maxDeviationPct,
          details: {
            value: reading.value,
            previous: previous.value,
            deviationPct,
            maxDeviationPct: feed.plausibility.maxDeviationPct,
          },
        });
      }
    }

    if (feed.plausibility?.maxFutureSkewMs !== undefined) {
      const skew = reading.observedAt - at;
      checks.push({
        name: 'max_future_skew',
        passed: skew <= feed.plausibility.maxFutureSkewMs,
        details: { skew, maxFutureSkewMs: feed.plausibility.maxFutureSkewMs },
      });
    }

    return checks;
  }

  // ---------------------------------------------------------------------------
  // Alerting
  // ---------------------------------------------------------------------------

  private raiseAlert(input: {
    feedId: string;
    type: OracleAlertType;
    severity: OracleAlertSeverity;
    message: string;
    details?: Record<string, unknown>;
  }): OracleAlert {
    const alert: OracleAlert = {
      id: randomUUID(),
      feedId: input.feedId,
      type: input.type,
      severity: input.severity,
      message: input.message,
      details: input.details ?? {},
      raisedAt: this.clock.now(),
      resolvedAt: null,
    };
    this.alerts.set(alert.id, alert);
    this.metrics.alertsRaised += 1;
    this.metrics.byFeed[input.feedId].alertsRaised += 1;
    this.emit('alert', alert);
    return alert;
  }

  private findOpenAlert(feedId: string, type: OracleAlertType): OracleAlert | undefined {
    for (const alert of this.alerts.values()) {
      if (alert.feedId === feedId && alert.type === type && alert.resolvedAt === null) {
        return alert;
      }
    }
    return undefined;
  }

  public resolveAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      throw new OracleError(OracleErrorCode.ALERT_NOT_FOUND, `Alert ${alertId} not found`);
    }
    if (alert.resolvedAt === null) {
      alert.resolvedAt = this.clock.now();
      this.emit('alertResolved', alert);
    }
  }

  public listAlerts(feedId?: string): OracleAlert[] {
    const all = Array.from(this.alerts.values());
    return feedId ? all.filter((a) => a.feedId === feedId) : all;
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  private addEvidence(evidence: OracleEvidence): void {
    this.evidence.push(evidence);
    if (this.evidence.length > this.config.maxEvidenceEntries) {
      this.evidence.splice(0, this.evidence.length - this.config.maxEvidenceEntries);
    }
    this.emit('evidence', evidence);
  }

  public listEvidence(feedId?: string): OracleEvidence[] {
    return feedId ? this.evidence.filter((e) => e.feedId === feedId) : [...this.evidence];
  }

  // ---------------------------------------------------------------------------
  // Readings
  // ---------------------------------------------------------------------------

  public getLatestReading(feedId: string): OracleReading | undefined {
    const feedReadings = this.readings.get(feedId);
    if (!feedReadings || feedReadings.length === 0) {
      return undefined;
    }
    return feedReadings[feedReadings.length - 1];
  }

  private getPreviousReading(feedId: string, currentId: string): OracleReading | undefined {
    const feedReadings = this.readings.get(feedId);
    if (!feedReadings) {
      return undefined;
    }
    const idx = feedReadings.findIndex((r) => r.id === currentId);
    if (idx <= 0) {
      return undefined;
    }
    return feedReadings[idx - 1];
  }

  public listReadings(feedId: string): OracleReading[] {
    return [...(this.readings.get(feedId) ?? [])];
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  public getMetrics(): OracleMetrics {
    return {
      ...this.metrics,
      byFeed: Object.fromEntries(
        Object.entries(this.metrics.byFeed).map(([k, v]) => [k, { ...v }]),
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requireFeed(feedId: string): OracleFeed {
    const feed = this.feeds.get(feedId);
    if (!feed) {
      throw new OracleError(OracleErrorCode.FEED_NOT_FOUND, `Feed ${feedId} is not registered`);
    }
    return feed;
  }
}