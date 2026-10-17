export type NonNumericConsensusStatus =
  | "corroborated"
  | "disagreement_split"
  | "insufficient_quorum"
  | "partial_reporting";

export interface CategoricalSourceReading<TCategory extends string = string> {
  sourceId: string;
  upstreamOrigin: string;
  category: TCategory;
  observedAtMs: number;
}

export interface CategoricalConsensusConfig {
  expectedTotalOrigins: number;
  minDistinctOrigins: number;
  supermajorityRatio: number; // e.g., 0.66
}

export interface CategoricalConsensusResult<TCategory extends string = string> {
  status: NonNumericConsensusStatus;
  agreedCategory: TCategory | null;
  confidenceBps: number;
  agreeingOrigins: string[];
  dissentingOrigins: string[];
  voteDistribution: Record<string, number>;
}

export function evaluateCategoricalConsensus<TCategory extends string>(
  readings: CategoricalSourceReading<TCategory>[],
  config: CategoricalConsensusConfig
): CategoricalConsensusResult<TCategory> {
  // Deduplicate by upstreamOrigin (latest reading wins per distinct origin)
  const latestByOrigin = new Map<string, CategoricalSourceReading<TCategory>>();
  for (const r of readings) {
    const existing = latestByOrigin.get(r.upstreamOrigin);
    if (!existing || r.observedAtMs >= existing.observedAtMs) {
      latestByOrigin.set(r.upstreamOrigin, r);
    }
  }

  const uniqueReadings = Array.from(latestByOrigin.values());
  const voteDistribution: Record<string, number> = {};
  const originsByCategory = new Map<TCategory, string[]>();

  for (const r of uniqueReadings) {
    voteDistribution[r.category] = (voteDistribution[r.category] ?? 0) + 1;
    const list = originsByCategory.get(r.category) ?? [];
    list.push(r.upstreamOrigin);
    originsByCategory.set(r.category, list);
  }

  if (uniqueReadings.length < config.minDistinctOrigins) {
    return {
      status:
        uniqueReadings.length > 0 ? "partial_reporting" : "insufficient_quorum",
      agreedCategory: null,
      confidenceBps: 0,
      agreeingOrigins: [],
      dissentingOrigins: uniqueReadings.map((r) => r.upstreamOrigin),
      voteDistribution,
    };
  }

  let topCategory: TCategory | null = null;
  let topCount = 0;
  for (const [cat, origins] of originsByCategory.entries()) {
    if (origins.length > topCount) {
      topCount = origins.length;
      topCategory = cat;
    }
  }

  const agreementRatio = topCount / uniqueReadings.length;
  if (
    !topCategory ||
    topCount < config.minDistinctOrigins ||
    agreementRatio < config.supermajorityRatio
  ) {
    return {
      status: "disagreement_split",
      agreedCategory: null,
      confidenceBps: Math.round(agreementRatio * 5_000),
      agreeingOrigins: topCategory
        ? originsByCategory.get(topCategory) ?? []
        : [],
      dissentingOrigins: uniqueReadings
        .filter((r) => r.category !== topCategory)
        .map((r) => r.upstreamOrigin),
      voteDistribution,
    };
  }

  const agreeingOrigins = originsByCategory.get(topCategory) ?? [];
  const dissentingOrigins = uniqueReadings
    .filter((r) => r.category !== topCategory)
    .map((r) => r.upstreamOrigin);

  const coverageRatio = Math.min(
    1,
    uniqueReadings.length /
      Math.max(config.expectedTotalOrigins, config.minDistinctOrigins)
  );
  const confidenceBps = Math.round(
    (agreementRatio * 0.7 + coverageRatio * 0.3) * 10_000
  );

  return {
    status: "corroborated",
    agreedCategory: topCategory,
    confidenceBps,
    agreeingOrigins,
    dissentingOrigins,
    voteDistribution,
  };
}

export interface DiscreteEventObservation {
  sourceId: string;
  upstreamOrigin: string;
  asset: string;
  venue: string;
  magnitudeUsd: number;
  occurredAtMs: number;
}

export interface DiscreteEventConsensusConfig {
  minDistinctOrigins: number;
  maxTimeSkewMs: number;
  magnitudeToleranceRatio: number;
}

export interface DiscreteEventConsensusResult {
  status: NonNumericConsensusStatus;
  corroborated: boolean;
  asset: string | null;
  venue: string | null;
  agreedMagnitudeUsd: number | null;
  agreedOccurredAtMs: number | null;
  confidenceBps: number;
  agreeingOrigins: string[];
}

export function evaluateDiscreteEventConsensus(
  observations: DiscreteEventObservation[],
  config: DiscreteEventConsensusConfig
): DiscreteEventConsensusResult {
  const latestByOrigin = new Map<string, DiscreteEventObservation>();
  for (const obs of observations) {
    const existing = latestByOrigin.get(obs.upstreamOrigin);
    if (!existing || obs.occurredAtMs >= existing.occurredAtMs) {
      latestByOrigin.set(obs.upstreamOrigin, obs);
    }
  }

  const uniqueObs = Array.from(latestByOrigin.values());
  if (uniqueObs.length < config.minDistinctOrigins) {
    return {
      status:
        uniqueObs.length > 0 ? "partial_reporting" : "insufficient_quorum",
      corroborated: false,
      asset: null,
      venue: null,
      agreedMagnitudeUsd: null,
      agreedOccurredAtMs: null,
      confidenceBps: 0,
      agreeingOrigins: [],
    };
  }

  // Find largest mutually compatible cluster across (asset, venue, timeSkew, magnitudeTolerance)
  let bestCluster: DiscreteEventObservation[] = [];

  for (const anchor of uniqueObs) {
    const cluster = uniqueObs.filter((candidate) => {
      if (
        candidate.asset.toUpperCase() !== anchor.asset.toUpperCase() ||
        candidate.venue.toLowerCase() !== anchor.venue.toLowerCase()
      ) {
        return false;
      }
      if (
        Math.abs(candidate.occurredAtMs - anchor.occurredAtMs) >
        config.maxTimeSkewMs
      ) {
        return false;
      }
      const denom = Math.max(Math.abs(anchor.magnitudeUsd), 1e-9);
      return (
        Math.abs(candidate.magnitudeUsd - anchor.magnitudeUsd) / denom <=
        config.magnitudeToleranceRatio
      );
    });

    if (cluster.length > bestCluster.length) {
      bestCluster = cluster;
    }
  }

  if (bestCluster.length < config.minDistinctOrigins) {
    return {
      status: "disagreement_split",
      corroborated: false,
      asset: null,
      venue: null,
      agreedMagnitudeUsd: null,
      agreedOccurredAtMs: null,
      confidenceBps: Math.round((bestCluster.length / uniqueObs.length) * 4_000),
      agreeingOrigins: bestCluster.map((c) => c.upstreamOrigin),
    };
  }

  const sortedMag = bestCluster
    .map((c) => c.magnitudeUsd)
    .sort((a, b) => a - b);
  const sortedTime = bestCluster
    .map((c) => c.occurredAtMs)
    .sort((a, b) => a - b);
  const mid = Math.floor(bestCluster.length / 2);

  const agreedMagnitudeUsd =
    bestCluster.length % 2 === 0
      ? (sortedMag[mid - 1]! + sortedMag[mid]!) / 2
      : sortedMag[mid]!;
  const agreedOccurredAtMs =
    bestCluster.length % 2 === 0
      ? Math.round((sortedTime[mid - 1]! + sortedTime[mid]!) / 2)
      : sortedTime[mid]!;

  const agreementRatio = bestCluster.length / uniqueObs.length;
  return {
    status: "corroborated",
    corroborated: true,
    asset: bestCluster[0]!.asset.toUpperCase(),
    venue: bestCluster[0]!.venue.toLowerCase(),
    agreedMagnitudeUsd: Number(agreedMagnitudeUsd.toFixed(2)),
    agreedOccurredAtMs,
    confidenceBps: Math.round(agreementRatio * 10_000),
    agreeingOrigins: bestCluster.map((c) => c.upstreamOrigin),
  };
}
