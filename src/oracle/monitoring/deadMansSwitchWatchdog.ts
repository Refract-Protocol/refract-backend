export interface DeadMansSwitchHeartbeatPayload {
  service: "refract-oracle-pipeline";
  healthyFeedCount: number;
  totalFeedCount: number;
  lastSuccessfulPublishAtMs: number;
  completedCycleAtMs: number;
}

export type MetaMonitoringAlertCode =
  | "PIPELINE_CYCLE_STALLED"
  | "METRICS_SCRAPE_LAPSED"
  | "HEARTBEAT_RECEIVER_UNREACHABLE";

export interface MetaWatchdogAlert {
  code: MetaMonitoringAlertCode;
  timestampMs: number;
  detail: string;
}

export class DeadMansSwitchWatchdog {
  private readonly maxCycleSilenceMs: number;
  private readonly maxMetricsScrapeSilenceMs: number;
  private readonly maxConsecutiveReceiverMisses: number;
  private readonly sendExternalHeartbeat: (
    payload: DeadMansSwitchHeartbeatPayload
  ) => Promise<void>;

  private lastCompletedCycleAtMs: number | null = null;
  private lastMetricsScrapedAtMs: number | null = null;
  private consecutiveReceiverMisses = 0;
  private readonly metaAlerts: MetaWatchdogAlert[] = [];

  constructor(options: {
    maxCycleSilenceMs?: number;
    maxMetricsScrapeSilenceMs?: number;
    maxConsecutiveReceiverMisses?: number;
    sendExternalHeartbeat: (
      payload: DeadMansSwitchHeartbeatPayload
    ) => Promise<void>;
  }) {
    this.maxCycleSilenceMs = options.maxCycleSilenceMs ?? 60_000;
    this.maxMetricsScrapeSilenceMs =
      options.maxMetricsScrapeSilenceMs ?? 120_000;
    this.maxConsecutiveReceiverMisses =
      options.maxConsecutiveReceiverMisses ?? 3;
    this.sendExternalHeartbeat = options.sendExternalHeartbeat;
  }

  public recordMetricsScrape(nowMs: number = Date.now()): void {
    this.lastMetricsScrapedAtMs = nowMs;
  }

  /**
   * Emits a heartbeat to the external dead-man's-switch receiver ONLY if both
   * the poll cycle and database persistence succeeded. A wedged or DB-failing
   * loop never sends a heartbeat.
   */
  public async onWorkCycleFinished(params: {
    pollCycleSucceeded: boolean;
    dbWriteSucceeded: boolean;
    healthyFeedCount: number;
    totalFeedCount: number;
    lastSuccessfulPublishAtMs: number;
    nowMs?: number;
  }): Promise<{ heartbeatSent: boolean; suppressedReason: string | null }> {
    const nowMs = params.nowMs ?? Date.now();

    if (!params.pollCycleSucceeded || !params.dbWriteSucceeded) {
      return {
        heartbeatSent: false,
        suppressedReason: "CYCLE_OR_DB_WRITE_INCOMPLETE",
      };
    }

    this.lastCompletedCycleAtMs = nowMs;
    const payload: DeadMansSwitchHeartbeatPayload = {
      service: "refract-oracle-pipeline",
      healthyFeedCount: params.healthyFeedCount,
      totalFeedCount: params.totalFeedCount,
      lastSuccessfulPublishAtMs: params.lastSuccessfulPublishAtMs,
      completedCycleAtMs: nowMs,
    };

    try {
      await this.sendExternalHeartbeat(payload);
      this.consecutiveReceiverMisses = 0;
      return { heartbeatSent: true, suppressedReason: null };
    } catch (err) {
      this.consecutiveReceiverMisses += 1;
      if (
        this.consecutiveReceiverMisses >= this.maxConsecutiveReceiverMisses
      ) {
        this.metaAlerts.push({
          code: "HEARTBEAT_RECEIVER_UNREACHABLE",
          timestampMs: nowMs,
          detail: `External dead-man's-switch receiver failed ${this.consecutiveReceiverMisses} consecutive times`,
        });
      }
      return {
        heartbeatSent: false,
        suppressedReason:
          err instanceof Error ? err.message : "RECEIVER_DELIVERY_FAILED",
      };
    }
  }

  public evaluateMetaWatchdog(nowMs: number = Date.now()): MetaWatchdogAlert[] {
    const triggered: MetaWatchdogAlert[] = [];

    if (
      this.lastCompletedCycleAtMs === null ||
      nowMs - this.lastCompletedCycleAtMs > this.maxCycleSilenceMs
    ) {
      const alert: MetaWatchdogAlert = {
        code: "PIPELINE_CYCLE_STALLED",
        timestampMs: nowMs,
        detail: "No completed oracle poll+DB cycle within maxCycleSilenceMs",
      };
      triggered.push(alert);
      this.metaAlerts.push(alert);
    }

    if (
      this.lastMetricsScrapedAtMs === null ||
      nowMs - this.lastMetricsScrapedAtMs > this.maxMetricsScrapeSilenceMs
    ) {
      const alert: MetaWatchdogAlert = {
        code: "METRICS_SCRAPE_LAPSED",
        timestampMs: nowMs,
        detail: "Prometheus /metrics endpoint has not been scraped within grace window",
      };
      triggered.push(alert);
      this.metaAlerts.push(alert);
    }

    return triggered;
  }

  public getMetaAlerts(): MetaWatchdogAlert[] {
    return [...this.metaAlerts];
  }
}
