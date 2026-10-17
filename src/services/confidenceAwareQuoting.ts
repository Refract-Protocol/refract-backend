export type CoverageQuoteAvailability =
  | "available"
  | "degraded"
  | "unavailable";

export interface FeedConfidenceTelemetry {
  coverageType: string;
  rawConfidenceBps: number; // 0 .. 10_000
  isMockedSource: boolean;
  circuitBreakerTripped: boolean;
  updatedAtMs: number;
}

export interface ConfidencePricingPolicy {
  fullConfidenceBps: number; // e.g., 8_500 (no surcharge at or above)
  minAvailableConfidenceBps: number; // e.g., 6_000 (below this -> unavailable)
  maxRiskMultiplier: number; // e.g., 1.50 (50% max surcharge)
  maxTelemetryAgeMs: number; // e.g., 60_000
  smoothingAlpha: number; // e.g., 0.4 EMA factor to damp premium oscillation
}

export interface ConfidenceAdjustedQuoteResponse {
  httpStatus: 200 | 409;
  coverageType: string;
  availability: CoverageQuoteAvailability;
  smoothedConfidenceBps: number;
  riskMultiplier: number | null;
  basePremiumUsd: number;
  finalPremiumUsd: number | null;
  warning: string | null;
  errorCode:
    | "COVERAGE_MOCK_SOURCE_UNQUOTABLE"
    | "COVERAGE_BREAKER_TRIPPED"
    | "COVERAGE_CONFIDENCE_STALE"
    | "COVERAGE_CONFIDENCE_TOO_LOW"
    | null;
}

const DEFAULT_POLICY: ConfidencePricingPolicy = {
  fullConfidenceBps: 8_500,
  minAvailableConfidenceBps: 6_000,
  maxRiskMultiplier: 1.5,
  maxTelemetryAgeMs: 60_000,
  smoothingAlpha: 0.4,
};

export class ConfidenceAwareQuotingService {
  private readonly policy: ConfidencePricingPolicy;
  private readonly latestTelemetry = new Map<string, FeedConfidenceTelemetry>();
  private readonly smoothedBpsByCoverage = new Map<string, number>();

  constructor(policy: Partial<ConfidencePricingPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  public recordConfidenceTelemetry(telemetry: FeedConfidenceTelemetry): number {
    const clampedRaw = Math.max(
      0,
      Math.min(10_000, Math.round(telemetry.rawConfidenceBps))
    );
    const prev = this.smoothedBpsByCoverage.get(telemetry.coverageType);
    const alpha = Math.max(0.05, Math.min(1, this.policy.smoothingAlpha));
    const nextSmoothed =
      prev === undefined
        ? clampedRaw
        : Math.round(alpha * clampedRaw + (1 - alpha) * prev);

    this.smoothedBpsByCoverage.set(telemetry.coverageType, nextSmoothed);
    this.latestTelemetry.set(telemetry.coverageType, {
      ...telemetry,
      rawConfidenceBps: clampedRaw,
    });
    return nextSmoothed;
  }

  public computeQuote(params: {
    coverageType: string;
    basePremiumUsd: number;
    nowMs?: number;
  }): ConfidenceAdjustedQuoteResponse {
    const nowMs = params.nowMs ?? Date.now();
    const telemetry = this.latestTelemetry.get(params.coverageType);
    const smoothedConfidenceBps =
      this.smoothedBpsByCoverage.get(params.coverageType) ?? 0;

    if (!telemetry || nowMs - telemetry.updatedAtMs > this.policy.maxTelemetryAgeMs) {
      return {
        httpStatus: 409,
        coverageType: params.coverageType,
        availability: "unavailable",
        smoothedConfidenceBps,
        riskMultiplier: null,
        basePremiumUsd: params.basePremiumUsd,
        finalPremiumUsd: null,
        warning: null,
        errorCode: "COVERAGE_CONFIDENCE_STALE",
      };
    }

    if (telemetry.isMockedSource) {
      return {
        httpStatus: 409,
        coverageType: params.coverageType,
        availability: "unavailable",
        smoothedConfidenceBps,
        riskMultiplier: null,
        basePremiumUsd: params.basePremiumUsd,
        finalPremiumUsd: null,
        warning: null,
        errorCode: "COVERAGE_MOCK_SOURCE_UNQUOTABLE",
      };
    }

    if (telemetry.circuitBreakerTripped) {
      return {
        httpStatus: 409,
        coverageType: params.coverageType,
        availability: "unavailable",
        smoothedConfidenceBps,
        riskMultiplier: null,
        basePremiumUsd: params.basePremiumUsd,
        finalPremiumUsd: null,
        warning: null,
        errorCode: "COVERAGE_BREAKER_TRIPPED",
      };
    }

    if (smoothedConfidenceBps < this.policy.minAvailableConfidenceBps) {
      return {
        httpStatus: 409,
        coverageType: params.coverageType,
        availability: "unavailable",
        smoothedConfidenceBps,
        riskMultiplier: null,
        basePremiumUsd: params.basePremiumUsd,
        finalPremiumUsd: null,
        warning: null,
        errorCode: "COVERAGE_CONFIDENCE_TOO_LOW",
      };
    }

    if (smoothedConfidenceBps >= this.policy.fullConfidenceBps) {
      return {
        httpStatus: 200,
        coverageType: params.coverageType,
        availability: "available",
        smoothedConfidenceBps,
        riskMultiplier: 1.0,
        basePremiumUsd: params.basePremiumUsd,
        finalPremiumUsd: Number(params.basePremiumUsd.toFixed(2)),
        warning: null,
        errorCode: null,
      };
    }

    // Degraded band: linear interpolation of multiplier between 1.0 and maxRiskMultiplier
    const bandSpan = Math.max(
      1,
      this.policy.fullConfidenceBps - this.policy.minAvailableConfidenceBps
    );
    const deficitRatio =
      (this.policy.fullConfidenceBps - smoothedConfidenceBps) / bandSpan;
    const rawMultiplier =
      1 + deficitRatio * (this.policy.maxRiskMultiplier - 1);
    const boundedMultiplier = Number(
      Math.min(this.policy.maxRiskMultiplier, Math.max(1, rawMultiplier)).toFixed(4)
    );
    const finalPremiumUsd = Number(
      (params.basePremiumUsd * boundedMultiplier).toFixed(2)
    );

    return {
      httpStatus: 200,
      coverageType: params.coverageType,
      availability: "degraded",
      smoothedConfidenceBps,
      riskMultiplier: boundedMultiplier,
      basePremiumUsd: params.basePremiumUsd,
      finalPremiumUsd,
      warning: `Oracle feed confidence is degraded (${smoothedConfidenceBps} bps); risk multiplier ${boundedMultiplier}x applied`,
      errorCode: null,
    };
  }
}
