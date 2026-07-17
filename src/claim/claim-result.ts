export interface ClaimResult {
  policyId: string;
  holder: string;
  coverageType: number;
  triggered: boolean;
  payout: string; // 1e7 USDC base units, decimal string
  reason: string;
  processedAt: number;
  /** Set once the Soroban process_claim() transaction actually confirms. */
  settlementTxHash?: string;
}
