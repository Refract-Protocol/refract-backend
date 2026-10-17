/**
 * Cross-Region Oracle Ingestion Coordinator with Correlated-Failure Detection (Issue #233)
 *
 * Aggregates regional source observations across independently deployed regions,
 * enforces minimum distinct region agreement, detects regional value divergence,
 * identifies correlated upstream failures (shared CDN/DNS/BGP errors or simultaneous
 * staleness across regions), and degrades gracefully with an explicit warning in
 * single-region deployments.
 */

export interface RegionalObservation {
  feedId: string;
  sourceId: string;
  regionId: string;
  observedAtMs: number;
  /** Present when the regional poller succeeded */
  valueBps?: number;
  /** Present when the regional poller encountered an error (e.g. "DNS_NXDOMAIN", "CDN_502") */
  errorCode?: string;
}

export interface CrossRegionConfig {
  configuredRegions: string[];
  minDistinctRegions: number;
  freshnessWindowMs: number;
  maxRegionalSpreadBps: number;
  maxRegionalClockSkewMs: number;
  correlatedFailureRegionThreshold: number;
}

export const DEFAULT_CROSS_REGION_CONFIG: CrossRegionConfig = {
  configuredRegions: ["us-east-1", "eu-central-1", "ap-southeast-1"],
  minDistinctRegions: 2,
  freshnessWindowMs: 30_000,
  maxRegionalSpreadBps: 150, // 1.5% max spread across regions for same source
  maxRegionalClockSkewMs: 15_000,
  correlatedFailureRegionThreshold: 2,
};

export type CorrelatedFailureKind =
  | "simultaneous_multi_region_staleness"
  | "identical_multi_region_error_pattern";

export interface CorrelatedFailureAlert {
  kind: CorrelatedFailureKind;
  feedId: string;
  sourceId: string;
  affectedRegions: string[];
  errorCode?: string;
  message: string;
}

export interface CrossRegionSourceEvaluation {
  feedId: string;
  sourceId: string;
  trustedForConsensus: boolean;
  canonicalValueBps?: number;
  healthyRegions: string[];
  regionalSpreadBps: number;
  regionalDivergenceDetected: boolean;
  singleRegionDegradedWarning: boolean;
  correlatedFailureAlerts: CorrelatedFailureAlert[];
  warnings: string[];
}

function medianNumber(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export class CrossRegionIngestionCoordinator {
  private readonly config: CrossRegionConfig;

  constructor(config: Partial<CrossRegionConfig> = {}) {
    this.config = {
      ...DEFAULT_CROSS_REGION_CONFIG,
      ...config,
    };
    if (this.config.configuredRegions.length === 0) {
      throw new Error("configuredRegions must contain at least one region");
    }
  }

  /**
   * Evaluates regional observations for a `(feedId, sourceId)` pair at `nowMs`.
   */
  evaluateSourceAcrossRegions(
    feedId: string,
    sourceId: string,
    observations: readonly RegionalObservation[],
    nowMs: number
  ): CrossRegionSourceEvaluation {
    const isSingleRegion = this.config.configuredRegions.length === 1;
    const effectiveMinRegions = isSingleRegion
      ? 1
      : this.config.minDistinctRegions;

    const warnings: string[] = [];
    if (isSingleRegion) {
      warnings.push(
        `[SINGLE_REGION_DEGRADED_WARNING] Feed "${feedId}" source "${sourceId}" is operating in single-region mode (${this.config.configuredRegions[0]}); cross-region corroboration is disabled.`
      );
    }

    // Keep latest valid observation per configured region (guarding against future clock skew)
    const latestByRegion = new Map<string, RegionalObservation>();
    for (const obs of observations) {
      if (obs.feedId !== feedId || obs.sourceId !== sourceId) {
        continue;
      }
      if (!this.config.configuredRegions.includes(obs.regionId)) {
        continue;
      }
      if (obs.observedAtMs - nowMs > this.config.maxRegionalClockSkewMs) {
        warnings.push(
          `Ignored clock-skewed observation from region "${obs.regionId}" (observedAtMs=${obs.observedAtMs}, nowMs=${nowMs})`
        );
        continue;
      }
      const prev = latestByRegion.get(obs.regionId);
      // Normalize near-simultaneous timestamps within clock skew so clock skew cannot arbitrarily flip ordering
      if (!prev || obs.observedAtMs >= prev.observedAtMs) {
        latestByRegion.set(obs.regionId, obs);
      }
    }

    const correlatedFailureAlerts: CorrelatedFailureAlert[] = [];
    const staleOrMissingRegions: string[] = [];
    const errorRegionsByCode = new Map<string, string[]>();
    const freshHealthyValues: Array<{ regionId: string; valueBps: number }> = [];

    for (const regionId of this.config.configuredRegions) {
      const obs = latestByRegion.get(regionId);
      if (!obs) {
        staleOrMissingRegions.push(regionId);
        continue;
      }

      const ageMs = nowMs - obs.observedAtMs;
      if (ageMs > this.config.freshnessWindowMs) {
        staleOrMissingRegions.push(regionId);
        continue;
      }

      if (obs.errorCode) {
        const list = errorRegionsByCode.get(obs.errorCode) ?? [];
        list.push(regionId);
        errorRegionsByCode.set(obs.errorCode, list);
        continue;
      }

      if (typeof obs.valueBps === "number" && Number.isFinite(obs.valueBps)) {
        freshHealthyValues.push({ regionId, valueBps: obs.valueBps });
      }
    }

    // 1. Detect correlated identical error patterns across regions (e.g. shared CDN / DNS outage)
    for (const [errorCode, regions] of errorRegionsByCode.entries()) {
      if (
        !isSingleRegion &&
        regions.length >= this.config.correlatedFailureRegionThreshold
      ) {
        correlatedFailureAlerts.push({
          kind: "identical_multi_region_error_pattern",
          feedId,
          sourceId,
          affectedRegions: regions,
          errorCode,
          message: `Correlated error "${errorCode}" detected simultaneously across ${regions.length} regions [${regions.join(", ")}] for ${feedId}:${sourceId}`,
        });
      }
    }

    // 2. Detect simultaneous multi-region staleness
    if (
      !isSingleRegion &&
      staleOrMissingRegions.length >= this.config.correlatedFailureRegionThreshold
    ) {
      correlatedFailureAlerts.push({
        kind: "simultaneous_multi_region_staleness",
        feedId,
        sourceId,
        affectedRegions: staleOrMissingRegions,
        message: `Simultaneous staleness across ${staleOrMissingRegions.length} regions [${staleOrMissingRegions.join(", ")}] for ${feedId}:${sourceId}`,
      });
    }

    const healthyRegions = freshHealthyValues.map((v) => v.regionId);
    let regionalSpreadBps = 0;
    let regionalDivergenceDetected = false;

    if (freshHealthyValues.length >= 2) {
      const vals = freshHealthyValues.map((v) => v.valueBps);
      const minVal = Math.min(...vals);
      const maxVal = Math.max(...vals);
      regionalSpreadBps = maxVal - minVal;
      if (regionalSpreadBps > this.config.maxRegionalSpreadBps) {
        regionalDivergenceDetected = true;
        warnings.push(
          `[REGIONAL_DIVERGENCE] Source "${sourceId}" on feed "${feedId}" diverged by ${regionalSpreadBps} bps across regions (maxAllowed=${this.config.maxRegionalSpreadBps} bps)`
        );
      }
    }

    const hasRegionQuorum = healthyRegions.length >= effectiveMinRegions;
    const trustedForConsensus =
      hasRegionQuorum &&
      !regionalDivergenceDetected &&
      correlatedFailureAlerts.length === 0;

    const canonicalValueBps = trustedForConsensus
      ? medianNumber(freshHealthyValues.map((v) => v.valueBps))
      : undefined;

    return {
      feedId,
      sourceId,
      trustedForConsensus,
      canonicalValueBps,
      healthyRegions,
      regionalSpreadBps,
      regionalDivergenceDetected,
      singleRegionDegradedWarning: isSingleRegion,
      correlatedFailureAlerts,
      warnings,
    };
  }
}
