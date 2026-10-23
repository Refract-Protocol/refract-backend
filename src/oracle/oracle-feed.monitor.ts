import { Injectable, Logger } from "@nestjs/common";
import { AlertingService } from "../alerting/alerting.service";
import { MetricsService } from "../metrics/metrics.service";

export interface OracleFeedObservation {
  /** Age in seconds of the newest reading that fed this evaluation. */
  readingAgeSeconds: number;
  /** Latest value from each independent source; omit when only one source exists. */
  sourceValues?: number[];
}

type BreachKind = "stale" | "divergent";

/**
 * Evaluates each oracle evaluation cycle against the staleness and dispersion
 * thresholds. A breach alerts only after ORACLE_ALERT_CONSECUTIVE_BREACHES
 * cycles in a row, so one slow poll does not page the on-call operator, and a
 * single healthy cycle resets the streak.
 *
 * Thresholds (env):
 *  - ORACLE_STALENESS_THRESHOLD_SECONDS (default 900)
 *  - ORACLE_DISPERSION_THRESHOLD (default 0.02, i.e. 2% relative spread)
 *  - ORACLE_ALERT_CONSECUTIVE_BREACHES (default 3)
 *  - ORACLE_ALERT_WEBHOOK_URL (optional; delivered fire-and-forget)
 *
 * Alerts never include raw source values, upstream URLs, or API keys.
 */
@Injectable()
export class OracleFeedMonitor {
  private readonly logger = new Logger(OracleFeedMonitor.name);
  private readonly stalenessThresholdSeconds = Number(
    process.env.ORACLE_STALENESS_THRESHOLD_SECONDS ?? 900,
  );
  private readonly dispersionThreshold = Number(
    process.env.ORACLE_DISPERSION_THRESHOLD ?? 0.02,
  );
  private readonly consecutiveBreaches = Number(
    process.env.ORACLE_ALERT_CONSECUTIVE_BREACHES ?? 3,
  );
  private readonly webhookUrl = process.env.ORACLE_ALERT_WEBHOOK_URL;
  private readonly streaks = new Map<string, number>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly alerting: AlertingService,
  ) {}

  observe(coverageType: string, observation: OracleFeedObservation): void {
    this.metrics.setOracleReadingAge(coverageType, observation.readingAgeSeconds);

    const dispersion = observation.sourceValues
      ? relativeSpread(observation.sourceValues)
      : undefined;
    if (dispersion !== undefined) {
      this.metrics.setOracleSourceDispersion(coverageType, dispersion);
    }

    this.track(coverageType, "stale", observation.readingAgeSeconds > this.stalenessThresholdSeconds, {
      readingAgeSeconds: observation.readingAgeSeconds,
      thresholdSeconds: this.stalenessThresholdSeconds,
    });
    this.track(coverageType, "divergent", dispersion !== undefined && dispersion > this.dispersionThreshold, {
      dispersion,
      threshold: this.dispersionThreshold,
    });
  }

  private track(
    coverageType: string,
    kind: BreachKind,
    breached: boolean,
    detail: Record<string, unknown>,
  ): void {
    const key = `${kind}:${coverageType}`;
    const previous = this.streaks.get(key) ?? 0;

    if (!breached) {
      this.streaks.delete(key);
      if (previous >= this.consecutiveBreaches) {
        this.alerting.emit("info", `Oracle feed ${kind} resolved`, `${coverageType} is back within threshold`, {
          coverageType,
        });
      }
      return;
    }

    const streak = previous + 1;
    this.streaks.set(key, streak);
    if (streak !== this.consecutiveBreaches) return;

    const title = kind === "stale" ? "Oracle feed stale" : "Oracle feed divergent";
    const message = `${coverageType} breached threshold for ${streak} consecutive cycles`;
    const context = { coverageType, consecutiveBreaches: streak, ...detail };
    this.alerting.emit("critical", title, message, context);
    this.postWebhook({ severity: "critical", title, message, ...context });
  }

  private postWebhook(payload: Record<string, unknown>): void {
    if (!this.webhookUrl) return;

    // Fire-and-forget so webhook latency never blocks the publish path. The URL
    // is deliberately not logged: it may embed a delivery token.
    fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      this.logger.warn(`Oracle alert webhook delivery failed for "${String(payload.title)}"`);
    });
  }
}

/** (max - min) / |mean|; Infinity when the mean is zero but sources disagree. */
export function relativeSpread(values: number[]): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (max === min) return 0;
  return mean === 0 ? Infinity : (max - min) / Math.abs(mean);
}
