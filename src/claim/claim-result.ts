export interface ClaimResult {
  policyId: string;
  holder: string;
  coverageType: number;
  triggered: boolean;
  /** Authoritative payout recorded after settlement (actual on-chain when known). */
  payout: string; // 1e7 USDC base units, decimal string
  /** Locally-expected payout before on-chain reconciliation. */
  expectedPayout?: string;
  reason: string;
  processedAt: number;
  /**
   * When the trigger condition was first detected for this claim, distinct from
   * `processedAt` (which is set after settlement). Used by the transparency API
   * to compute settlement latency (trigger detected -> payout confirmed).
   */
  triggerDetectedAt?: number;
  /** Set once the Soroban process_claim() transaction actually confirms. */
  settlementTxHash?: string;
  /** When the payout was confirmed on-chain (settlement-confirmed timestamp). */
  settledAt?: number;
  /** True when |actual - expected| exceeded the configured tolerance. */
  payoutDiscrepancy?: boolean;
}

export interface ClaimScanStats {
  policiesExamined: number;
  triggered: number;
  settled: number;
  failed: number;
  durationMs: number;
}

export interface PayoutDiscrepancyRecord {
  policyId: string;
  expectedPayout: string;
  actualPayout: string | null;
  txHash?: string;
  at: number;
}

/**
 * Per-coverage-type operational performance metrics exposed by the public
 * transparency API (GET /api/v1/transparency/settlement-latency).
 *
 * Latency is measured in milliseconds from trigger detection to on-chain
 * settlement confirmation. Percentiles are computed in SQL via PERCENTILE_CONT.
 */
export interface SettlementLatencyStats {
  coverageType: number;
  /** Number of settled claims with both timestamps available. */
  sampleSize: number;
  /** p50 settlement latency in milliseconds. */
  p50LatencyMs: number | null;
  /** p90 settlement latency in milliseconds. */
  p90LatencyMs: number | null;
  /** p99 settlement latency in milliseconds. */
  p99LatencyMs: number | null;
  /** Mean settlement latency in milliseconds. */
  meanLatencyMs: number | null;
  /** Total payouts settled for this coverage type (1e7 USDC base units, decimal string). */
  totalPayout: string;
  /** Total premiums collected for this coverage type (1e7 USDC base units, decimal string). */
  totalPremium: string;
  /** Loss ratio = totalPayout / totalPremium (null when no premium recorded). */
  lossRatio: number | null;
}

export interface SettlementLatencyReport {
  generatedAt: number;
  /** Window in days over which the report was computed. */
  windowDays: number;
  coverageTypes: SettlementLatencyStats[];
}
