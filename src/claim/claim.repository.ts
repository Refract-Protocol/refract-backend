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

/**
 * A settled claim joined to the consensus decision and evidence record that
 * justify it. Used by the incident timeline generator and the DR restore drill.
 */
export interface SettledClaimWithEvidence {
  claimId: string;
  policyId: string;
  coverageType: string;
  status: string;
  payoutAmount: number | null;
  processedAt: string;
  decisionId: string | null;
  feedId: string | null;
  evidenceId: string | null;
  evidenceSequence: number | null;
}

interface SettledClaimWithEvidenceRow {
  claim_id: string;
  policy_id: string;
  coverage_type: string;
  status: string;
  payout_amount: string | number | null;
  processed_at: string | Date;
  decision_id: string | null;
  feed_id: string | null;
  evidence_id: string | null;
  evidence_sequence: string | number | null;
}

/**
 * Result of the referential-integrity check: every settled claim in the window
 * must have a linked consensus decision and an evidence record.
 */
export interface SettledClaimIntegrityReport {
  windowStart: string;
  windowEnd: string;
  settledClaims: number;
  claimsMissingDecision: number;
  claimsMissingEvidence: number;
  missingDecisionClaimIds: string[];
  missingEvidenceClaimIds: string[];
  ok: boolean;
}

interface SettledClaimIntegrityRow {
  claim_id: string;
  has_decision: boolean;
  has_evidence: boolean;
}

/** Per-feed row counts used by the restore verification drill. */
export interface FeedRowCount {
  feedId: string;
  claimCount: number;
  settledClaimCount: number;
}

interface FeedRowCountRow {
  feed_id: string;
  claim_count: string | number;
  settled_claim_count: string | number;
}

/**
 * Query-budget policy: every query against the claims/evidence tables must
 * bound its timestamp range. These helpers reject unbounded windows loudly
 * rather than silently scanning the full history.
 */
const MAX_QUERY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_INTEGRITY_SAMPLE_IDS = 100;

function assertBoundedWindow(windowStart: Date, windowEnd: Date): void {
  if (!(windowStart instanceof Date) || Number.isNaN(windowStart.getTime())) {
    throw new Error('Query budget violation: windowStart must be a valid Date');
  }
  if (!(windowEnd instanceof Date) || Number.isNaN(windowEnd.getTime())) {
    throw new Error('Query budget violation: windowEnd must be a valid Date');
  }
  if (windowEnd.getTime() <= windowStart.getTime()) {
    throw new Error('Query budget violation: windowEnd must be after windowStart');
  }
  if (windowEnd.getTime() - windowStart.getTime() > MAX_QUERY_WINDOW_MS) {
    throw new Error(
      `Query budget violation: window exceeds ${MAX_QUERY_WINDOW_MS / (24 * 60 * 60 * 1000)} days; narrow the range or paginate`,
    );
  }
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

  /**
   * Bounded-range lookup of settled claims with their consensus decision and
   * evidence references. Used by the incident timeline generator to assemble
   * "claims settled, held, or reversed" for an incident window.
   *
   * The timestamp predicate is mandatory (query-budget policy) and is applied
   * on the partition key (processed_at) so only the relevant partitions are
   * scanned.
   */
  async findSettledClaimsWithEvidence(
    windowStart: Date,
    windowEnd: Date,
    options: { feedId?: string; limit?: number } = {},
  ): Promise<SettledClaimWithEvidence[]> {
    assertBoundedWindow(windowStart, windowEnd);
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);

    const params: unknown[] = [windowStart, windowEnd];
    let feedFilter = '';
    if (options.feedId) {
      params.push(options.feedId);
      feedFilter = `AND c.feed_id = $${params.length}`;
    }
    params.push(limit);

    const rows = await this.db.query<SettledClaimWithEvidenceRow>(
      `SELECT
         c.id AS claim_id,
         c.policy_id,
         c.coverage_type,
         c.status,
         c.payout_amount,
         c.processed_at,
         d.id AS decision_id,
         d.feed_id,
         e.id AS evidence_id,
         e.sequence AS evidence_sequence
       FROM claims c
       LEFT JOIN consensus_decisions d ON d.id = c.decision_id
       LEFT JOIN evidence_ledger e ON e.decision_id = d.id
       WHERE c.processed_at >= $1
         AND c.processed_at < $2
         ${feedFilter}
       ORDER BY c.processed_at ASC, c.id ASC
       LIMIT $${params.length}`,
      params,
    );

    return rows.map((row) => ({
      claimId: row.claim_id,
      policyId: row.policy_id,
      coverageType: row.coverage_type,
      status: row.status,
      payoutAmount: toNullableNumber(row.payout_amount),
      processedAt: toIsoString(row.processed_at),
      decisionId: row.decision_id,
      feedId: row.feed_id,
      evidenceId: row.evidence_id,
      evidenceSequence: toNullableNumber(row.evidence_sequence),
    }));
  }

  /**
   * Referential-integrity check used by the DR restore drill: every settled
   * claim in the window must have a consensus decision and an evidence record.
   * Returns a bounded sample of offending claim ids for diagnostics.
   */
  async verifySettledClaimIntegrity(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<SettledClaimIntegrityReport> {
    assertBoundedWindow(windowStart, windowEnd);

    const rows = await this.db.query<SettledClaimIntegrityRow>(
      `SELECT
         c.id AS claim_id,
         (c.decision_id IS NOT NULL AND d.id IS NOT NULL) AS has_decision,
         (e.id IS NOT NULL) AS has_evidence
       FROM claims c
       LEFT JOIN consensus_decisions d ON d.id = c.decision_id
       LEFT JOIN evidence_ledger e ON e.decision_id = d.id
       WHERE c.processed_at >= $1
         AND c.processed_at < $2
         AND c.status = 'settled'`,
      [windowStart, windowEnd],
    );

    const missingDecisionClaimIds: string[] = [];
    const missingEvidenceClaimIds: string[] = [];
    for (const row of rows) {
      if (!row.has_decision && missingDecisionClaimIds.length < MAX_INTEGRITY_SAMPLE_IDS) {
        missingDecisionClaimIds.push(row.claim_id);
      }
      if (!row.has_evidence && missingEvidenceClaimIds.length < MAX_INTEGRITY_SAMPLE_IDS) {
        missingEvidenceClaimIds.push(row.claim_id);
      }
    }

    const claimsMissingDecision = rows.filter((row) => !row.has_decision).length;
    const claimsMissingEvidence = rows.filter((row) => !row.has_evidence).length;

    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      settledClaims: rows.length,
      claimsMissingDecision,
      claimsMissingEvidence,
      missingDecisionClaimIds,
      missingEvidenceClaimIds,
      ok: claimsMissingDecision === 0 && claimsMissingEvidence === 0,
    };
  }

  /**
   * Per-feed row counts within a bounded window, used by the restore
   * verification drill to compare a restored database against the source
   * backup within tolerance.
   */
  async getFeedRowCounts(windowStart: Date, windowEnd: Date): Promise<FeedRowCount[]> {
    assertBoundedWindow(windowStart, windowEnd);

    const rows = await this.db.query<FeedRowCountRow>(
      `SELECT
         c.feed_id,
         COUNT(*) AS claim_count,
         COUNT(*) FILTER (WHERE c.status = 'settled') AS settled_claim_count
       FROM claims c
       WHERE c.processed_at >= $1
         AND c.processed_at < $2
         AND c.feed_id IS NOT NULL
       GROUP BY c.feed_id
       ORDER BY c.feed_id ASC`,
      [windowStart, windowEnd],
    );

    return rows.map((row) => ({
      feedId: row.feed_id,
      claimCount: toNumber(row.claim_count),
      settledClaimCount: toNumber(row.settled_claim_count),
    }));
  }
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
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
