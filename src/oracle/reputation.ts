/**
 * Operator reputation scoring and consensus weighting (model: operator-reputation/v1).
 *
 * Pure functions over an immutable history window. No I/O, no clock reads:
 * the caller passes `now`, so the same history + `now` always yields the same
 * score and weights (replay-stable). All arithmetic is integer basis points
 * (0–10000), so results are reproducible across runtimes.
 *
 * See docs/operator-reputation.md for the model and its parameters.
 */

export const REPUTATION_MODEL_VERSION = "operator-reputation/v1";

const BPS = 10_000;

/** Exponential decay: influence halves every HALF_LIFE_MS. */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** Weight after HALF_LIFE_STEPS half-lives is 0 (10_000 >> 14 === 0). */
const HALF_LIFE_STEPS = 14;
/** Equivalent to one fresh, fully weighted event; keeps denominators > 0. */
const PRIOR_WEIGHT = BPS;
/** Tenure reaches full credit after this long. */
export const TENURE_FULL_MS = 90 * 24 * 60 * 60 * 1000;

/** Component weights in percent; they sum to 100. */
const COMPONENT_WEIGHTS = { accuracy: 40, availability: 25, disputes: 25, tenure: 10 } as const;

/** Probation: below either threshold the operator is read-only (recorded, excluded from quorum). */
export const MIN_HISTORY_OBSERVATIONS = 30;
export const ELIGIBILITY_THRESHOLD_BPS = 5_000;

/** Consensus weight range for eligible operators. Floor keeps low-rep operators contributing. */
export const MIN_CONSENSUS_WEIGHT_BPS = 1_000;
/**
 * Cap on a single operator's weight. With MIN_QUORUM_OPERATORS >= 3 eligible
 * operators, one operator's share is at most MAX / (MAX + (n - 1) * MIN) <= 1/2,
 * so no single operator can unilaterally decide a weighted median.
 */
export const MAX_CONSENSUS_WEIGHT_BPS = 2_000;
export const MIN_QUORUM_OPERATORS = 3;

export interface OperatorObservation {
  /** Epoch ms when the operator's report was recorded. */
  observedAt: number;
  /** |operatorValue - corroboratedValue| / corroboratedValue in bps, integer >= 0. */
  deviationBps: number;
  /** Whether the report arrived within the feed's heartbeat window. */
  heartbeatMet: boolean;
  /** True when the feed itself was down; excluded from availability scoring. */
  excused?: boolean;
}

export interface OperatorDispute {
  /** Epoch ms when the dispute was resolved. */
  resolvedAt: number;
  /** "upheld" = operator found at fault (slashed); "rejected" = cleared. */
  outcome: "upheld" | "rejected";
}

export interface OperatorHistory {
  operatorId: string;
  /** Epoch ms of operator registration. */
  registeredAt: number;
  observations: readonly OperatorObservation[];
  disputes: readonly OperatorDispute[];
}

export interface ReputationComponents {
  accuracy: number;
  availability: number;
  disputes: number;
  tenure: number;
}

export interface ReputationScore {
  operatorId: string;
  /** Overall score, 0–10000. */
  score: number;
  components: ReputationComponents;
  /** Count of non-excused observations at or before `now`. */
  observationCount: number;
  eligible: boolean;
  /** Consensus weight in bps; 0 when not eligible. */
  weight: number;
  asOf: number;
}

export type QuorumStatus = "ok" | "insufficient" | "no_eligible_operators";

export interface WeightedQuorum {
  status: QuorumStatus;
  eligibleCount: number;
  scores: ReputationScore[];
}

/** Integer decay weight in bps for an event `ageMs` old. Non-increasing in age. */
function decayWeight(ageMs: number): number {
  const steps = Math.floor(Math.max(0, ageMs) / HALF_LIFE_MS);
  return steps >= HALF_LIFE_STEPS ? 0 : BPS >> steps;
}

/** Decayed weighted mean of `samples`, smoothed toward `prior`. Never divides by zero. */
function decayedMean(
  samples: ReadonlyArray<{ at: number; value: number }>,
  prior: number,
  now: number,
): number {
  let sumWeight = PRIOR_WEIGHT;
  let sumValue = PRIOR_WEIGHT * prior;
  for (const sample of samples) {
    if (sample.at > now) continue;
    const weight = decayWeight(now - sample.at);
    sumWeight += weight;
    sumValue += weight * sample.value;
  }
  return Math.floor(sumValue / sumWeight);
}

function clampBps(value: number): number {
  return Math.min(BPS, Math.max(0, Math.floor(value)));
}

/**
 * Scores one operator from its history as of `now`.
 * Monotonic: lower deviation, more heartbeats, fewer upheld disputes, or longer
 * tenure never lower the score. Order of input arrays does not affect the result.
 */
export function scoreOperator(history: OperatorHistory, now: number): ReputationScore {
  const observations = history.observations.filter(
    (o) => !o.excused && o.observedAt <= now,
  );

  const accuracy = decayedMean(
    observations.map((o) => ({
      at: o.observedAt,
      value: BPS - clampBps(o.deviationBps),
    })),
    0,
    now,
  );

  const availability = decayedMean(
    observations.map((o) => ({ at: o.observedAt, value: o.heartbeatMet ? BPS : 0 })),
    0,
    now,
  );

  // No upheld disputes is the clean baseline; upheld disputes pull it down.
  const disputes = decayedMean(
    history.disputes.map((d) => ({
      at: d.resolvedAt,
      value: d.outcome === "upheld" ? 0 : BPS,
    })),
    BPS,
    now,
  );

  const tenure = clampBps(((now - history.registeredAt) * BPS) / TENURE_FULL_MS);

  const components: ReputationComponents = { accuracy, availability, disputes, tenure };
  const score = Math.floor(
    (COMPONENT_WEIGHTS.accuracy * accuracy +
      COMPONENT_WEIGHTS.availability * availability +
      COMPONENT_WEIGHTS.disputes * disputes +
      COMPONENT_WEIGHTS.tenure * tenure) /
      100,
  );

  const eligible =
    observations.length >= MIN_HISTORY_OBSERVATIONS && score >= ELIGIBILITY_THRESHOLD_BPS;

  return {
    operatorId: history.operatorId,
    score,
    components,
    observationCount: observations.length,
    eligible,
    weight: eligible ? consensusWeight(score) : 0,
    asOf: now,
  };
}

/** Linear map of an eligible score onto [MIN_CONSENSUS_WEIGHT_BPS, MAX_CONSENSUS_WEIGHT_BPS]. */
function consensusWeight(score: number): number {
  const span = MAX_CONSENSUS_WEIGHT_BPS - MIN_CONSENSUS_WEIGHT_BPS;
  const headroom = BPS - ELIGIBILITY_THRESHOLD_BPS;
  const position = Math.min(headroom, Math.max(0, score - ELIGIBILITY_THRESHOLD_BPS));
  return MIN_CONSENSUS_WEIGHT_BPS + Math.floor((position * span) / headroom);
}

/**
 * Scores every operator for a feed and reports whether quorum is possible.
 * Callers must alert on any status other than "ok" and must not finalize a
 * payout-triggering decision without it. Scores are returned sorted by operatorId.
 */
export function weightOperators(
  histories: readonly OperatorHistory[],
  now: number,
): WeightedQuorum {
  const scores = histories
    .map((h) => scoreOperator(h, now))
    .sort((a, b) => (a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0));

  const eligibleCount = scores.filter((s) => s.eligible).length;

  let status: QuorumStatus = "ok";
  if (eligibleCount === 0) status = "no_eligible_operators";
  else if (eligibleCount < MIN_QUORUM_OPERATORS) status = "insufficient";

  return { status, eligibleCount, scores };
}
