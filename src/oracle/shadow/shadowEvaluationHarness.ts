export type SourceRegistrationMode = "active" | "shadow";

export interface RegisteredOracleSource {
  sourceId: string;
  feedId: string;
  mode: SourceRegistrationMode;
  promotedAtMs?: number;
  promotionEvaluationId?: string;
}

export interface WindowedSourceReading {
  sourceId: string;
  feedId: string;
  windowTimestampMs: number;
  value: number;
}

export interface DisagreementEpisode {
  windowTimestampMs: number;
  incumbentValue: number;
  shadowValue: number;
  deviationBps: number;
}

export interface ShadowComparisonReport {
  evaluationId: string;
  feedId: string;
  candidateSourceId: string;
  windowStartMs: number;
  windowEndMs: number;
  totalIncumbentWindows: number;
  sampleSize: number;
  coverageGapWindows: number[];
  agreementRate: number;
  medianAbsoluteDeviationBps: number;
  disagreementEpisodes: DisagreementEpisode[];
}

export interface ShadowPromotionRecord {
  sourceId: string;
  feedId: string;
  evaluationId: string;
  actor: string;
  promotedAtMs: number;
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export class ShadowEvaluationHarness {
  private readonly sources = new Map<string, RegisteredOracleSource>();
  private readonly readings: WindowedSourceReading[] = [];
  private readonly reports = new Map<string, ShadowComparisonReport>();
  private readonly promotions: ShadowPromotionRecord[] = [];

  public registerSource(source: RegisteredOracleSource): void {
    this.sources.set(`${source.feedId}:${source.sourceId}`, { ...source });
  }

  public getSource(
    feedId: string,
    sourceId: string
  ): RegisteredOracleSource | undefined {
    return this.sources.get(`${feedId}:${sourceId}`);
  }

  public recordReading(reading: WindowedSourceReading): void {
    const source = this.getSource(reading.feedId, reading.sourceId);
    if (!source) {
      throw new Error(
        `Unregistered source '${reading.sourceId}' for feed '${reading.feedId}'`
      );
    }
    this.readings.push({ ...reading });
  }

  /**
   * Computes the corroborated median strictly from `active` sources for a value window.
   * Shadow sources are completely excluded from quorum and payout decisions.
   */
  public evaluateActiveConsensusForWindow(
    feedId: string,
    windowTimestampMs: number
  ): { consensusValue: number | null; activeContributorIds: string[] } {
    const activeReadings = this.readings.filter((r) => {
      if (r.feedId !== feedId || r.windowTimestampMs !== windowTimestampMs) {
        return false;
      }
      const src = this.getSource(feedId, r.sourceId);
      return src?.mode === "active";
    });

    if (activeReadings.length === 0) {
      return { consensusValue: null, activeContributorIds: [] };
    }

    return {
      consensusValue: computeMedian(activeReadings.map((r) => r.value)),
      activeContributorIds: activeReadings.map((r) => r.sourceId),
    };
  }

  /**
   * Aligns candidate shadow source readings with incumbent corroborated outcomes by
   * `windowTimestampMs` and generates an immutable comparison report.
   */
  public generateComparisonReport(params: {
    evaluationId: string;
    feedId: string;
    candidateSourceId: string;
    windowStartMs: number;
    windowEndMs: number;
    agreementToleranceBps: number;
  }): ShadowComparisonReport {
    const source = this.getSource(params.feedId, params.candidateSourceId);
    if (!source || source.mode !== "shadow") {
      throw new Error(
        `Source '${params.candidateSourceId}' must be registered in shadow mode`
      );
    }

    const uniqueWindows = Array.from(
      new Set(
        this.readings
          .filter(
            (r) =>
              r.feedId === params.feedId &&
              r.windowTimestampMs >= params.windowStartMs &&
              r.windowTimestampMs <= params.windowEndMs
          )
          .map((r) => r.windowTimestampMs)
      )
    ).sort((a, b) => a - b);

    const coverageGapWindows: number[] = [];
    const deviationsBps: number[] = [];
    const disagreementEpisodes: DisagreementEpisode[] = [];
    let agreedCount = 0;
    let totalIncumbentWindows = 0;

    for (const windowTs of uniqueWindows) {
      const incumbent = this.evaluateActiveConsensusForWindow(
        params.feedId,
        windowTs
      );
      if (incumbent.consensusValue === null || incumbent.consensusValue === 0) {
        continue;
      }
      totalIncumbentWindows += 1;

      const candidateReading = this.readings.find(
        (r) =>
          r.feedId === params.feedId &&
          r.sourceId === params.candidateSourceId &&
          r.windowTimestampMs === windowTs
      );

      if (!candidateReading) {
        coverageGapWindows.push(windowTs);
        continue;
      }

      const deviationBps =
        (Math.abs(candidateReading.value - incumbent.consensusValue) /
          Math.abs(incumbent.consensusValue)) *
        10_000;
      deviationsBps.push(deviationBps);

      if (deviationBps <= params.agreementToleranceBps) {
        agreedCount += 1;
      } else {
        disagreementEpisodes.push({
          windowTimestampMs: windowTs,
          incumbentValue: incumbent.consensusValue,
          shadowValue: candidateReading.value,
          deviationBps,
        });
      }
    }

    const sampleSize = deviationsBps.length;
    const report: ShadowComparisonReport = {
      evaluationId: params.evaluationId,
      feedId: params.feedId,
      candidateSourceId: params.candidateSourceId,
      windowStartMs: params.windowStartMs,
      windowEndMs: params.windowEndMs,
      totalIncumbentWindows,
      sampleSize,
      coverageGapWindows,
      agreementRate: sampleSize > 0 ? agreedCount / sampleSize : 0,
      medianAbsoluteDeviationBps: computeMedian(deviationsBps),
      disagreementEpisodes,
    };

    this.reports.set(params.evaluationId, report);
    return report;
  }

  /**
   * Audits and promotes a shadow source to active mode, requiring a stored evaluation report
   * that meets minimum sample size and agreement rate criteria.
   */
  public promoteShadowSource(params: {
    feedId: string;
    candidateSourceId: string;
    evaluationId: string;
    actor: string;
    minSampleSize: number;
    minAgreementRate: number;
    nowMs?: number;
  }): ShadowPromotionRecord {
    const report = this.reports.get(params.evaluationId);
    if (
      !report ||
      report.feedId !== params.feedId ||
      report.candidateSourceId !== params.candidateSourceId
    ) {
      throw new Error(
        `Missing or mismatched shadow evaluation report '${params.evaluationId}'`
      );
    }

    if (report.sampleSize < params.minSampleSize) {
      throw new Error(
        `Shadow source sample size ${report.sampleSize} below required minimum ${params.minSampleSize}`
      );
    }

    if (report.agreementRate < params.minAgreementRate) {
      throw new Error(
        `Shadow source agreement rate ${report.agreementRate.toFixed(2)} below required ${params.minAgreementRate}`
      );
    }

    const source = this.getSource(params.feedId, params.candidateSourceId);
    if (!source || source.mode !== "shadow") {
      throw new Error(
        `Source '${params.candidateSourceId}' is not currently in shadow mode`
      );
    }

    const promotedAtMs = params.nowMs ?? Date.now();
    source.mode = "active";
    source.promotedAtMs = promotedAtMs;
    source.promotionEvaluationId = params.evaluationId;

    const record: ShadowPromotionRecord = {
      sourceId: params.candidateSourceId,
      feedId: params.feedId,
      evaluationId: params.evaluationId,
      actor: params.actor,
      promotedAtMs,
    };
    this.promotions.push(record);
    return record;
  }
}
