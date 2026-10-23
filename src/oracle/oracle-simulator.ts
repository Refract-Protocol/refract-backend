import { parseFixed, formatFixed } from "../common/fixed-point";
import { z } from "zod";

export const SIMULATION_COVERAGE_TYPES = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;

export type SimulationCoverageType = (typeof SIMULATION_COVERAGE_TYPES)[number];

export const OracleSimulationCandidate = z
  .object({
    schemaVersion: z.literal(1),
    quorum: z.number().int().min(1).max(20),
    freshnessSeconds: z.number().int().min(1).max(86_400),
    anomalyDeviationPct: z.number().finite().min(0).max(1_000),
    thresholds: z
      .object({
        StablecoinDepeg: z.number().finite().optional(),
        MarketCrash: z.number().finite().optional(),
        LiquidationShield: z.number().finite().optional(),
        SmartContractRisk: z.number().finite().optional(),
        FlightDelay: z.number().finite().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type OracleSimulationCandidate = z.infer<typeof OracleSimulationCandidate>;

export interface HistoricalOracleObservation {
  coverageType: SimulationCoverageType;
  value: number;
  source: string;
  severity: string;
  recordedAt: Date;
}

export interface HistoricalPayoutSummary {
  settledClaims: number;
  payoutTotal: string;
}

export interface OracleSimulationWindow {
  from: Date;
  to: Date;
}

export interface OracleSimulationResult {
  schemaVersion: 1;
  window: { from: string; to: string };
  readingsProcessed: number;
  decisionWindows: number;
  coverageTypes: Record<
    SimulationCoverageType,
    {
      baselineTriggers: number;
      candidateTriggers: number;
      changedToTrigger: number;
      changedToNoTrigger: number;
      quorumRejected: number;
      anomalyFiltered: number;
      historicalSettledClaims: number;
      historicalPayoutTotal: string;
      estimatedBaselinePayout: string;
      estimatedCandidatePayout: string;
      estimatedPayoutDelta: string;
    }
  >;
  estimatedBaselinePayout: string;
  estimatedCandidatePayout: string;
  estimatedPayoutDelta: string;
  payoutEstimateNote: string;
}

const DEFAULT_THRESHOLDS: Record<SimulationCoverageType, number> = {
  StablecoinDepeg: 0.95,
  MarketCrash: -30,
  LiquidationShield: 0.85,
  SmartContractRisk: -50,
  FlightDelay: 120,
};

interface DecisionWindow {
  coverageType: SimulationCoverageType;
  at: number;
  observations: HistoricalOracleObservation[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function triggered(coverageType: SimulationCoverageType, value: number, threshold: number): boolean {
  return coverageType === "FlightDelay" ? value > threshold : value < threshold;
}

function groupDecisionWindows(readings: HistoricalOracleObservation[]): DecisionWindow[] {
  const grouped = new Map<string, DecisionWindow>();
  for (const reading of readings) {
    const at = Math.floor(reading.recordedAt.getTime() / 1_000) * 1_000;
    const key = `${reading.coverageType}:${at}`;
    const window = grouped.get(key);
    if (window) {
      window.observations.push(reading);
    } else {
      grouped.set(key, { coverageType: reading.coverageType, at, observations: [reading] });
    }
  }
  return [...grouped.values()].sort(
    (left, right) => left.at - right.at || left.coverageType.localeCompare(right.coverageType),
  );
}

function estimatePayout(total: bigint, claims: number, decisions: number): bigint {
  if (claims <= 0 || decisions <= 0) return 0n;
  return (total / BigInt(claims)) * BigInt(decisions);
}

export function simulateOracleParameters(
  readings: HistoricalOracleObservation[],
  payoutHistory: Partial<Record<SimulationCoverageType, HistoricalPayoutSummary>>,
  candidateInput: unknown,
  window: OracleSimulationWindow,
): OracleSimulationResult {
  const candidate = OracleSimulationCandidate.parse(candidateInput);
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new RangeError("Simulation window must have valid dates with from before to");
  }

  const sortedReadings = [...readings].sort(
    (left, right) => left.recordedAt.getTime() - right.recordedAt.getTime(),
  );
  for (const reading of sortedReadings) {
    if (
      !Number.isFinite(reading.recordedAt.getTime()) ||
      !Number.isFinite(reading.value) ||
      reading.source.trim().length === 0
    ) {
      throw new TypeError("Historical oracle readings must have valid timestamps, finite values, and a source");
    }
  }

  const results = Object.fromEntries(
    SIMULATION_COVERAGE_TYPES.map((coverageType) => [
      coverageType,
      {
        baselineTriggers: 0,
        candidateTriggers: 0,
        changedToTrigger: 0,
        changedToNoTrigger: 0,
        quorumRejected: 0,
        anomalyFiltered: 0,
        historicalSettledClaims: 0,
        historicalPayoutTotal: "0",
        estimatedBaselinePayout: "0",
        estimatedCandidatePayout: "0",
        estimatedPayoutDelta: "0",
      },
    ]),
  ) as OracleSimulationResult["coverageTypes"];

  const activeBySource = new Map<SimulationCoverageType, Map<string, HistoricalOracleObservation>>();
  let readingsProcessed = 0;
  let decisionWindows = 0;

  for (const decision of groupDecisionWindows(sortedReadings)) {
    if (decision.at > to) break;

    let sources = activeBySource.get(decision.coverageType);
    if (!sources) {
      sources = new Map();
      activeBySource.set(decision.coverageType, sources);
    }
    for (const observation of decision.observations) {
      sources.set(observation.source, observation);
    }

    const cutoff = decision.at - candidate.freshnessSeconds * 1_000;
    for (const [source, observation] of sources) {
      if (observation.recordedAt.getTime() < cutoff) sources.delete(source);
    }

    if (decision.at < from) continue;
    readingsProcessed += decision.observations.length;
    decisionWindows += 1;
    const summary = results[decision.coverageType];
    const baselineTriggered = decision.observations.some((item) => item.severity === "triggered");
    if (baselineTriggered) summary.baselineTriggers += 1;

    const observations = [...sources.values()];
    const threshold =
      candidate.thresholds[decision.coverageType] ?? DEFAULT_THRESHOLDS[decision.coverageType];
    const center = observations.length > 0 ? median(observations.map((item) => item.value)) : 0;
    const scale = Math.max(Math.abs(center), Math.abs(threshold), Number.EPSILON);
    const inliers = observations.filter(
      (item) => (Math.abs(item.value - center) / scale) * 100 <= candidate.anomalyDeviationPct,
    );
    summary.anomalyFiltered += observations.length - inliers.length;

    let candidateTriggered = false;
    if (inliers.length >= candidate.quorum) {
      const consensusValue = median(inliers.map((item) => item.value));
      candidateTriggered = triggered(decision.coverageType, consensusValue, threshold);
      if (candidateTriggered) summary.candidateTriggers += 1;
    } else {
      summary.quorumRejected += 1;
    }

    if (!baselineTriggered && candidateTriggered) summary.changedToTrigger += 1;
    if (baselineTriggered && !candidateTriggered) summary.changedToNoTrigger += 1;
  }

  let estimatedBaseline = 0n;
  let estimatedCandidate = 0n;
  for (const coverageType of SIMULATION_COVERAGE_TYPES) {
    const summary = results[coverageType];
    const history = payoutHistory[coverageType] ?? { settledClaims: 0, payoutTotal: "0" };
    if (!Number.isSafeInteger(history.settledClaims) || history.settledClaims < 0) {
      throw new RangeError(`Invalid historical settled claim count for ${coverageType}`);
    }
    const payoutTotal = parseFixed(history.payoutTotal);
    const baselineEstimate = estimatePayout(payoutTotal, history.settledClaims, summary.baselineTriggers);
    const candidateEstimate = estimatePayout(payoutTotal, history.settledClaims, summary.candidateTriggers);
    summary.historicalSettledClaims = history.settledClaims;
    summary.historicalPayoutTotal = formatFixed(payoutTotal);
    summary.estimatedBaselinePayout = formatFixed(baselineEstimate);
    summary.estimatedCandidatePayout = formatFixed(candidateEstimate);
    summary.estimatedPayoutDelta = formatFixed(candidateEstimate - baselineEstimate);
    estimatedBaseline += baselineEstimate;
    estimatedCandidate += candidateEstimate;
  }

  return {
    schemaVersion: 1,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    readingsProcessed,
    decisionWindows,
    coverageTypes: results,
    estimatedBaselinePayout: formatFixed(estimatedBaseline),
    estimatedCandidatePayout: formatFixed(estimatedCandidate),
    estimatedPayoutDelta: formatFixed(estimatedCandidate - estimatedBaseline),
    payoutEstimateNote:
      "Payout estimates scale the average settled payout per coverage type by simulated trigger decisions; they are indicative, not settlement predictions.",
  };
}
