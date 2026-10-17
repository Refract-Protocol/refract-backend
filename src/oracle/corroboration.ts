export type CorroborationStatus =
  | "corroborated"
  | "insufficient_quorum"
  | "divergent";

export interface SourceReading {
  sourceId: string;
  coverageType: string;
  value: number;
  observedAtMs: number;
}

export interface CorroborationPolicyConfig {
  coverageType: string;
  minQuorumSources: number;
  toleranceBandRatio: number;
  maxAbsoluteTolerance?: number;
  maxReadingAgeMs: number;
}

export interface RejectedSourceDiagnostic {
  sourceId: string;
  value: number;
  observedAtMs: number;
  reason: "duplicate_source_superseded" | "stale_reading" | "outlier_beyond_tolerance";
}

export interface CorroborationResult {
  coverageType: string;
  status: CorroborationStatus;
  canPublishOnChain: boolean;
  agreedValue: number | null;
  dispersion: number;
  participatingSources: SourceReading[];
  rejectedSources: RejectedSourceDiagnostic[];
  evaluatedAtMs: number;
}

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export class CorroborationEngine {
  private readonly policies = new Map<string, CorroborationPolicyConfig>();

  constructor(initialPolicies: CorroborationPolicyConfig[] = []) {
    for (const p of initialPolicies) {
      this.registerPolicy(p);
    }
  }

  public registerPolicy(policy: CorroborationPolicyConfig): void {
    if (policy.minQuorumSources < 1 || policy.toleranceBandRatio < 0 || policy.maxReadingAgeMs <= 0) {
      throw new Error(`Invalid corroboration policy for ${policy.coverageType}`);
    }
    this.policies.set(policy.coverageType, policy);
  }

  public evaluate(
    coverageType: string,
    readings: SourceReading[],
    nowMs: number = Date.now()
  ): CorroborationResult {
    const policy = this.policies.get(coverageType) ?? {
      coverageType,
      minQuorumSources: 3,
      toleranceBandRatio: 0.05,
      maxReadingAgeMs: 60_000,
    };

    return corroborateReadings(readings, policy, nowMs);
  }
}

export function corroborateReadings(
  readings: SourceReading[],
  policy: CorroborationPolicyConfig,
  nowMs: number
): CorroborationResult {
  const rejectedSources: RejectedSourceDiagnostic[] = [];

  // 1. Deduplicate by sourceId (keep freshest valid reading per sourceId)
  const freshestBySource = new Map<string, SourceReading>();
  for (const r of readings) {
    if (r.coverageType !== policy.coverageType || !Number.isFinite(r.value)) {
      continue;
    }
    const existing = freshestBySource.get(r.sourceId);
    if (!existing) {
      freshestBySource.set(r.sourceId, r);
    } else if (r.observedAtMs > existing.observedAtMs) {
      rejectedSources.push({
        sourceId: existing.sourceId,
        value: existing.value,
        observedAtMs: existing.observedAtMs,
        reason: "duplicate_source_superseded",
      });
      freshestBySource.set(r.sourceId, r);
    } else {
      rejectedSources.push({
        sourceId: r.sourceId,
        value: r.value,
        observedAtMs: r.observedAtMs,
        reason: "duplicate_source_superseded",
      });
    }
  }

  // 2. Filter out stale readings outside maxReadingAgeMs
  const freshReadings: SourceReading[] = [];
  for (const r of freshestBySource.values()) {
    const ageMs = nowMs - r.observedAtMs;
    if (ageMs > policy.maxReadingAgeMs || ageMs < -5_000) {
      rejectedSources.push({
        sourceId: r.sourceId,
        value: r.value,
        observedAtMs: r.observedAtMs,
        reason: "stale_reading",
      });
    } else {
      freshReadings.push(r);
    }
  }

  if (freshReadings.length < policy.minQuorumSources) {
    return {
      coverageType: policy.coverageType,
      status: "insufficient_quorum",
      canPublishOnChain: false,
      agreedValue: null,
      dispersion: 0,
      participatingSources: freshReadings,
      rejectedSources,
      evaluatedAtMs: nowMs,
    };
  }

  // 3. Find the largest mutually-consistent cluster or median-anchored agreement band
  const candidateValues = freshReadings.map((r) => r.value);
  const initialMedian = computeMedian(candidateValues);

  const isWithinTolerance = (val: number, anchor: number): boolean => {
    const absDiff = Math.abs(val - anchor);
    if (
      policy.maxAbsoluteTolerance !== undefined &&
      absDiff <= policy.maxAbsoluteTolerance
    ) {
      return true;
    }
    const denom = Math.max(Math.abs(anchor), 1e-9);
    return absDiff / denom <= policy.toleranceBandRatio + 1e-12;
  };

  const acceptedReadings: SourceReading[] = [];
  for (const r of freshReadings) {
    if (isWithinTolerance(r.value, initialMedian)) {
      acceptedReadings.push(r);
    } else {
      rejectedSources.push({
        sourceId: r.sourceId,
        value: r.value,
        observedAtMs: r.observedAtMs,
        reason: "outlier_beyond_tolerance",
      });
    }
  }

  if (acceptedReadings.length < policy.minQuorumSources) {
    return {
      coverageType: policy.coverageType,
      status: "divergent",
      canPublishOnChain: false,
      agreedValue: null,
      dispersion:
        Math.max(...candidateValues) - Math.min(...candidateValues),
      participatingSources: acceptedReadings,
      rejectedSources,
      evaluatedAtMs: nowMs,
    };
  }

  const acceptedValues = acceptedReadings.map((r) => r.value);
  const agreedValue = computeMedian(acceptedValues);
  const dispersion = Math.max(...acceptedValues) - Math.min(...acceptedValues);

  return {
    coverageType: policy.coverageType,
    status: "corroborated",
    canPublishOnChain: true,
    agreedValue,
    dispersion,
    participatingSources: acceptedReadings,
    rejectedSources,
    evaluatedAtMs: nowMs,
  };
}
