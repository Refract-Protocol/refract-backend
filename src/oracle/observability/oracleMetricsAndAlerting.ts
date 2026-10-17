export type BreakerGaugeState = "closed" | "half_open" | "open";

export interface OracleAlertNotification {
  alertType: "FEED_STALENESS_BREACH" | "FEED_DISPERSION_BREACH" | "QUORUM_FAILURE";
  coverageType: string;
  consecutiveBreaches: number;
  observedValue: number;
  thresholdValue: number;
  recommendedControl:
    | "operator_pause"
    | "breaker_inspection_and_source_quarantine";
  timestampMs: number;
}

export interface ObservabilityThresholdConfig {
  maxReadingAgeSeconds: number;
  maxDispersionRatio: number;
  minConsecutiveBreachesBeforeAlert: number;
}

const BREAKER_NUMERIC: Record<BreakerGaugeState, number> = {
  closed: 0,
  half_open: 1,
  open: 2,
};

export class OracleObservabilityMonitor {
  private readonly config: ObservabilityThresholdConfig;
  private readonly onAlert?: (alert: OracleAlertNotification) => void;

  private readonly sourceRequestDurationSec = new Map<string, number>();
  private readonly sourceFailuresTotal = new Map<string, number>();
  private readonly readingAgeSec = new Map<string, number>();
  private readonly sourceDispersion = new Map<string, number>();
  private readonly quorumFailuresTotal = new Map<string, number>();
  private readonly breakerState = new Map<string, number>();

  private readonly stalenessBreachStreak = new Map<string, number>();
  private readonly dispersionBreachStreak = new Map<string, number>();
  private readonly emittedAlerts: OracleAlertNotification[] = [];

  constructor(options: {
    config?: Partial<ObservabilityThresholdConfig>;
    onAlert?: (alert: OracleAlertNotification) => void;
  } = {}) {
    this.config = {
      maxReadingAgeSeconds: options.config?.maxReadingAgeSeconds ?? 120,
      maxDispersionRatio: options.config?.maxDispersionRatio ?? 0.05,
      minConsecutiveBreachesBeforeAlert:
        options.config?.minConsecutiveBreachesBeforeAlert ?? 3,
    };
    this.onAlert = options.onAlert;
  }

  /**
   * Sanitizes metric labels to keep cardinality bounded and prevent leaking URLs or secrets.
   */
  public static sanitizeLabelValue(raw: string): string {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/[^/]+/i, "url_redacted")
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 48);
    return cleaned || "unknown";
  }

  public recordSourceRequest(params: {
    source: string;
    durationSeconds: number;
    failed: boolean;
  }): void {
    const src = OracleObservabilityMonitor.sanitizeLabelValue(params.source);
    if (Number.isFinite(params.durationSeconds) && params.durationSeconds >= 0) {
      this.sourceRequestDurationSec.set(
        src,
        Number(params.durationSeconds.toFixed(4))
      );
    }
    if (params.failed) {
      this.sourceFailuresTotal.set(
        src,
        (this.sourceFailuresTotal.get(src) ?? 0) + 1
      );
    } else if (!this.sourceFailuresTotal.has(src)) {
      this.sourceFailuresTotal.set(src, 0);
    }
  }

  public recordFeedEvaluation(params: {
    coverageType: string;
    readingAgeSeconds: number;
    dispersionRatio: number;
    quorumFailed: boolean;
    breakerState: BreakerGaugeState;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    const cov = OracleObservabilityMonitor.sanitizeLabelValue(
      params.coverageType
    );

    this.readingAgeSec.set(cov, Math.max(0, params.readingAgeSeconds));
    this.sourceDispersion.set(cov, Math.max(0, params.dispersionRatio));
    this.breakerState.set(cov, BREAKER_NUMERIC[params.breakerState]);

    if (params.quorumFailed) {
      const nextQ = (this.quorumFailuresTotal.get(cov) ?? 0) + 1;
      this.quorumFailuresTotal.set(cov, nextQ);
    } else if (!this.quorumFailuresTotal.has(cov)) {
      this.quorumFailuresTotal.set(cov, 0);
    }

    // Consecutive staleness breach tracking
    if (params.readingAgeSeconds > this.config.maxReadingAgeSeconds) {
      const streak = (this.stalenessBreachStreak.get(cov) ?? 0) + 1;
      this.stalenessBreachStreak.set(cov, streak);
      if (streak >= this.config.minConsecutiveBreachesBeforeAlert) {
        this.emitAlert({
          alertType: "FEED_STALENESS_BREACH",
          coverageType: cov,
          consecutiveBreaches: streak,
          observedValue: params.readingAgeSeconds,
          thresholdValue: this.config.maxReadingAgeSeconds,
          recommendedControl: "operator_pause",
          timestampMs: nowMs,
        });
      }
    } else {
      this.stalenessBreachStreak.set(cov, 0);
    }

    // Consecutive dispersion breach tracking
    if (params.dispersionRatio > this.config.maxDispersionRatio) {
      const streak = (this.dispersionBreachStreak.get(cov) ?? 0) + 1;
      this.dispersionBreachStreak.set(cov, streak);
      if (streak >= this.config.minConsecutiveBreachesBeforeAlert) {
        this.emitAlert({
          alertType: "FEED_DISPERSION_BREACH",
          coverageType: cov,
          consecutiveBreaches: streak,
          observedValue: params.dispersionRatio,
          thresholdValue: this.config.maxDispersionRatio,
          recommendedControl: "breaker_inspection_and_source_quarantine",
          timestampMs: nowMs,
        });
      }
    } else {
      this.dispersionBreachStreak.set(cov, 0);
    }
  }

  public renderPrometheusMetrics(): string {
    const lines: string[] = [];

    for (const [source, val] of this.sourceRequestDurationSec.entries()) {
      lines.push(
        `oracle_source_request_duration_seconds{source="${source}"} ${val}`
      );
    }
    for (const [source, val] of this.sourceFailuresTotal.entries()) {
      lines.push(`oracle_source_failures_total{source="${source}"} ${val}`);
    }
    for (const [cov, val] of this.readingAgeSec.entries()) {
      lines.push(`oracle_reading_age_seconds{coverage_type="${cov}"} ${val}`);
    }
    for (const [cov, val] of this.sourceDispersion.entries()) {
      lines.push(`oracle_source_dispersion{coverage_type="${cov}"} ${val}`);
    }
    for (const [cov, val] of this.quorumFailuresTotal.entries()) {
      lines.push(
        `oracle_quorum_failures_total{coverage_type="${cov}"} ${val}`
      );
    }
    for (const [cov, val] of this.breakerState.entries()) {
      lines.push(`oracle_breaker_state{coverage_type="${cov}"} ${val}`);
    }

    return lines.join("\n");
  }

  public getEmittedAlerts(): OracleAlertNotification[] {
    return [...this.emittedAlerts];
  }

  private emitAlert(alert: OracleAlertNotification): void {
    this.emittedAlerts.push(alert);
    if (this.onAlert) {
      this.onAlert(alert);
    }
  }
}
