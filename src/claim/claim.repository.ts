import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { ClaimResult } from './claim-result';

/**
 * Per-coverage-type operational performance metrics derived from the claims
 * table. Latency is measured from the moment a trigger was first detected
 * (claims.trigger_detected_at) to the moment the payout was confirmed on-chain
 * (claims.processed_at). Percentiles are computed in SQL via PERCENTILE_CONT so
 * the numbers stay correct as the dataset grows.
 */
export interface SettlementLatencyStats {
  coverageType: string;
  sampleSize: number;
  p50LatencySeconds: number | null;
  p90LatencySeconds: number | null;
  p99LatencySeconds: number | null;
  avgLatencySeconds: number | null;
  totalClaims: number;
  settledClaims: number;
  totalPayoutAmount: number;
  totalPremiumAmount: number;
  lossRatio: number | null;
}

interface SettlementLatencyRow {
  coverage_type: string;
  sample_size: string | number;
  p50_latency_seconds: string | number | null;
  p90_latency_seconds: string | number | null;
  p99_latency_seconds: string | number | null;
  avg_latency_seconds: string | number | null;
  total_claims: string | number;
  settled_claims: string | number;
  total_payout_amount: string | number | null;
  total_premium_amount: string | number | null;
}

@Injectable()
export class ClaimRepository {
  constructor(private readonly db: DatabaseService) {}

  async save(result: ClaimResult): Promise<ClaimResult> {
    await this.db.query(
      `INSERT INTO claims (id, policy_id, coverage_type, status, payout_amount, premium_amount, trigger_detected_at, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         payout_amount = EXCLUDED.payout_amount,
         premium_amount = EXCLUDED.premium_amount,
         trigger_detected_at = EXCLUDED.trigger_detected_at,
         processed_at = EXCLUDED.processed_at`,
      [
        result.id,
        result.policyId,
        result.coverageType,
        result.status,
        result.payoutAmount ?? null,
        result.premiumAmount ?? null,
        result.triggerDetectedAt ?? null,
        result.processedAt ?? null,
      ],
    );
    return result;
  }

  async findById(id: string): Promise<ClaimResult | null> {
    const rows = await this.db.query<ClaimResult>(
      `SELECT id, policy_id AS "policyId", coverage_type AS "coverageType", status,
              payout_amount AS "payoutAmount", premium_amount AS "premiumAmount",
              trigger_detected_at AS "triggerDetectedAt", processed_at AS "processedAt"
       FROM claims WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Operational-performance reporting: settlement latency percentiles and loss
   * ratio per coverage type. Financial/treasury reporting lives elsewhere; this
   * query is scoped to claim-settlement performance only.
   */
  async getSettlementLatencyStats(): Promise<SettlementLatencyStats[]> {
    const rows = await this.db.query<SettlementLatencyRow>(
      `WITH settled AS (
         SELECT
           coverage_type,
           payout_amount,
           premium_amount,
           EXTRACT(EPOCH FROM (processed_at - trigger_detected_at)) AS latency_seconds
         FROM claims
         WHERE processed_at IS NOT NULL
           AND trigger_detected_at IS NOT NULL
           AND processed_at >= trigger_detected_at
       ),
       latency AS (
         SELECT
           coverage_type,
           COUNT(*) AS sample_size,
           PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_seconds) AS p50_latency_seconds,
           PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY latency_seconds) AS p90_latency_seconds,
           PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_seconds) AS p99_latency_seconds,
           AVG(latency_seconds) AS avg_latency_seconds
         FROM settled
         GROUP BY coverage_type
       ),
       totals AS (
         SELECT
           coverage_type,
           COUNT(*) AS total_claims,
           COUNT(*) FILTER (WHERE processed_at IS NOT NULL) AS settled_claims,
           COALESCE(SUM(payout_amount) FILTER (WHERE processed_at IS NOT NULL), 0) AS total_payout_amount,
           COALESCE(SUM(premium_amount), 0) AS total_premium_amount
         FROM claims
         GROUP BY coverage_type
       )
       SELECT
         t.coverage_type,
         COALESCE(l.sample_size, 0) AS sample_size,
         l.p50_latency_seconds,
         l.p90_latency_seconds,
         l.p99_latency_seconds,
         l.avg_latency_seconds,
         t.total_claims,
         t.settled_claims,
         t.total_payout_amount,
         t.total_premium_amount
       FROM totals t
       LEFT JOIN latency l ON l.coverage_type = t.coverage_type
       ORDER BY t.coverage_type ASC`,
    );

    return rows.map((row) => {
      const totalPremium = toNumber(row.total_premium_amount);
      const totalPayout = toNumber(row.total_payout_amount);
      return {
        coverageType: row.coverage_type,
        sampleSize: toNumber(row.sample_size),
        p50LatencySeconds: toNullableNumber(row.p50_latency_seconds),
        p90LatencySeconds: toNullableNumber(row.p90_latency_seconds),
        p99LatencySeconds: toNullableNumber(row.p99_latency_seconds),
        avgLatencySeconds: toNullableNumber(row.avg_latency_seconds),
        totalClaims: toNumber(row.total_claims),
        settledClaims: toNumber(row.settled_claims),
        totalPayoutAmount: totalPayout,
        totalPremiumAmount: totalPremium,
        lossRatio: totalPremium > 0 ? totalPayout / totalPremium : null,
      };
    });
  }
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === 'number' ? value : Number(value);
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
