/**
 * Represents a single row in the lp_position_events append-only ledger.
 *
 * All NUMERIC(30,0) database fields are carried as decimal strings to
 * avoid BigInt/float64 precision loss — the same convention used by
 * StoredPolicy.coverageAmount and ClaimResult.payout.
 */
export type LpEventType = "deposit" | "withdrawal" | "premium_accrual";

export interface LpEvent {
  /** Auto-incrementing surrogate key from the database (BIGSERIAL). */
  id: number;
  /** Stellar address of the liquidity provider. */
  provider: string;
  /** Type of the event. */
  eventType: LpEventType;
  /**
   * Signed share delta in 1e7 base units (decimal string).
   * Positive for deposits and premium accruals; negative for withdrawals.
   */
  deltaShares: string;
  /**
   * Signed USDC delta in 1e7 base units (decimal string).
   * Positive for deposits; negative for withdrawals; zero for premium_accrual
   * (premium adjusts shares, not deposited USDC principal).
   */
  deltaUsdc: string;
  /** Confirmed on-chain transaction hash, if this event originated from a Soroban call. */
  txHash: string | null;
  /** Stellar ledger sequence at which the transaction was confirmed, if known. */
  ledgerSeq: number | null;
  /** UTC timestamp when this row was written. */
  recordedAt: string;
}
