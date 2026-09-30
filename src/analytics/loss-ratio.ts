/** Postgres `coverage_type` enum values (src/db/schema.sql). */
export type CoverageTypeKey =
  | "stablecoin_depeg"
  | "market_crash"
  | "liquidation_shield"
  | "smart_contract_risk"
  | "flight_delay";

/**
 * One coverage type's totals for a time window, as produced by
 * `SUM(premium_revenue.amount)` / `SUM(claims.payout)` grouped by
 * `coverage_type`. Amounts are 1e7 fixed-point USDC; `pg` returns
 * NUMERIC(30, 0) as a string, so callers convert with `BigInt(row.sum)`.
 */
export interface CoverageAggregate {
  coverageType: CoverageTypeKey;
  premiumCollected: bigint;
  claimsPaid: bigint;
}

export interface LossRatioLine {
  premiumCollected: string;
  claimsPaid: string;
  /**
   * claimsPaid / premiumCollected in basis points, rounded down
   * (10_000 = 100%). `null` when no premium was collected: the ratio is
   * undefined there, and 0 would hide claims paid against no revenue.
   */
  lossRatioBps: number | null;
}

export interface LossRatioReport {
  overall: LossRatioLine;
  byCoverageType: Array<LossRatioLine & { coverageType: CoverageTypeKey }>;
}

/**
 * One coverage type's settlement-latency percentiles, as produced by
 * Postgres `PERCENTILE_CONT` over `claims.settled_at - claims.trigger_detected_at`
 * (seconds). Percentiles are computed in SQL, not approximated here.
 */
export interface SettlementLatencyAggregate {
  coverageType: CoverageTypeKey;
  /** Number of settled claims the percentiles were computed over. */
  sampleSize: number;
  p50Seconds: number | null;
  p90Seconds: number | null;
  p99Seconds: number | null;
}

export interface SettlementLatencyLine {
  sampleSize: number;
  p50Seconds: number | null;
  p90Seconds: number | null;
  p99Seconds: number | null;
}

export interface SettlementLatencyReport {
  overall: SettlementLatencyLine;
  byCoverageType: Array<SettlementLatencyLine & { coverageType: CoverageTypeKey }>;
}

const BPS = 10_000n;

function line(premiumCollected: bigint, claimsPaid: bigint): LossRatioLine {
  return {
    premiumCollected: premiumCollected.toString(),
    claimsPaid: claimsPaid.toString(),
    lossRatioBps: premiumCollected === 0n ? null : Number((claimsPaid * BPS) / premiumCollected),
  };
}

/**
 * Builds the loss-ratio report from per-coverage-type aggregates. Rows for
 * the same coverage type are summed, so a caller can feed premium and
 * claims aggregates from two separate GROUP BY queries without merging
 * them first. `byCoverageType` is sorted by coverage type for a stable
 * response shape.
 */
export function computeLossRatio(rows: readonly CoverageAggregate[]): LossRatioReport {
  const totals = new Map<CoverageTypeKey, { premium: bigint; claims: bigint }>();
  for (const row of rows) {
    if (row.premiumCollected < 0n || row.claimsPaid < 0n) {
      throw new RangeError(`negative aggregate for ${row.coverageType}`);
    }
    const t = totals.get(row.coverageType) ?? { premium: 0n, claims: 0n };
    t.premium += row.premiumCollected;
    t.claims += row.claimsPaid;
    totals.set(row.coverageType, t);
  }

  let premium = 0n;
  let claims = 0n;
  const byCoverageType = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([coverageType, t]) => {
      premium += t.premium;
      claims += t.claims;
      return { coverageType, ...line(t.premium, t.claims) };
    });

  return { overall: line(premium, claims), byCoverageType };
}

function latencyLine(row: SettlementLatencyAggregate): SettlementLatencyLine {
  return {
    sampleSize: row.sampleSize,
    p50Seconds: row.p50Seconds,
    p90Seconds: row.p90Seconds,
    p99Seconds: row.p99Seconds,
  };
}

/**
 * Builds the settlement-latency report from per-coverage-type percentile
 * aggregates. Percentiles are computed in SQL (`PERCENTILE_CONT`) and only
 * shaped here, so the growing dataset is never pulled into application
 * memory. `byCoverageType` is sorted by coverage type for a stable response
 * shape; `overall` is the sample-size-weighted mean of the per-type
 * percentiles (a true overall percentile would require a second SQL pass).
 */
export function computeSettlementLatency(
  rows: readonly SettlementLatencyAggregate[],
): SettlementLatencyReport {
  const byCoverageType = [...rows]
    .sort((a, b) => a.coverageType.localeCompare(b.coverageType))
    .map((row) => ({ coverageType: row.coverageType, ...latencyLine(row) }));

  const totalSamples = rows.reduce((sum, row) => sum + row.sampleSize, 0);
  const weighted = (pick: (row: SettlementLatencyAggregate) => number | null): number | null => {
    if (totalSamples === 0) return null;
    let acc = 0;
    for (const row of rows) {
      const value = pick(row);
      if (value === null) continue;
      acc += value * row.sampleSize;
    }
    return acc / totalSamples;
  };

  return {
    overall: {
      sampleSize: totalSamples,
      p50Seconds: weighted((row) => row.p50Seconds),
      p90Seconds: weighted((row) => row.p90Seconds),
      p99Seconds: weighted((row) => row.p99Seconds),
    },
    byCoverageType,
  };
}
