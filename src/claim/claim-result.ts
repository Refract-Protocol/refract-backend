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
  /** Set once the Soroban process_claim() transaction actually confirms. */
  settlementTxHash?: string;
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
