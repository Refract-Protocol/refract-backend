import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../db/database.service";

export type ClaimSettlementStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface ClaimSettlementRecord {
  decisionId: string;
  policyId: string;
  amount: string;
  status: ClaimSettlementStatus;
  txHash?: string;
  lastError?: string;
}

const UNIQUE_VIOLATION = "23505";

/**
 * Raised when a settlement read fails at the database layer. Distinct from a
 * null return, which means the row genuinely does not exist.
 */
export class ClaimSettlementReadError extends Error {
  readonly code = "CLAIM_SETTLEMENT_READ_FAILED";

  constructor(readonly decisionId: string, readonly cause?: unknown) {
    super(
      `Failed to read claim settlement for decision ${decisionId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "ClaimSettlementReadError";
    Object.setPrototypeOf(this, ClaimSettlementReadError.prototype);
  }
}

/**
 * Durable settlement state machine keyed by consensus decision id
 * (see buildDecisionId in src/oracle/oracle-encoding.ts).
 *
 *   pending → submitted → confirmed
 *   pending → failed          (definitively rejected; may be re-claimed)
 *
 * `submitted` and `pending` rows are never resubmitted by this repository:
 * their on-chain outcome is unknown until reconciled against tx_hash.
 */
@Injectable()
export class ClaimSettlementRepository {
  private readonly logger = new Logger(ClaimSettlementRepository.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Takes ownership of a decision for settlement. Returns true only when this
   * caller now holds the claim. False means a non-failed row already exists for
   * this decision or for this policy, so the caller must not submit on-chain.
   */
  async claim(decisionId: string, policyId: string, amount: string, evidence: object): Promise<boolean> {
    try {
      const result = await this.db.query(
        `INSERT INTO claim_settlements (decision_id, policy_id, amount, status, evidence)
         VALUES ($1, $2, $3, 'pending', $4)
         ON CONFLICT (decision_id) DO UPDATE SET
           status = 'pending',
           amount = EXCLUDED.amount,
           evidence = EXCLUDED.evidence,
           last_error = NULL,
           updated_at = now()
         WHERE claim_settlements.status = 'failed'
         RETURNING decision_id`,
        [decisionId, policyId, amount, JSON.stringify(evidence)]
      );
      return result.rows.length > 0;
    } catch (err) {
      // Another decision for the same policy holds an open settlement.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) return false;
      throw err;
    }
  }

  /**
   * Returns the settlement row for a decision, or null when no row exists.
   * A failed query is never reported as "not found": it is logged and rethrown
   * as a ClaimSettlementReadError so callers can distinguish the two.
   */
  async findByDecisionId(decisionId: string): Promise<ClaimSettlementRecord | null> {
    try {
      const result = await this.db.query<ClaimSettlementRecord>(
        `SELECT decision_id AS "decisionId", policy_id AS "policyId", amount::text AS amount,
                status, tx_hash AS "txHash", last_error AS "lastError"
         FROM claim_settlements WHERE decision_id = $1`,
        [decisionId]
      );
      return result.rows[0] ?? null;
    } catch (err) {
      this.logger.error(
        `Failed to read claim_settlements for decision ${decisionId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      throw new ClaimSettlementReadError(decisionId, err);
    }
  }

  /** Records the transaction hash before broadcast, so a crash can be reconciled. */
  async markSubmitted(decisionId: string, txHash: string): Promise<void> {
    await this.db.query(
      `UPDATE claim_settlements SET status = 'submitted', tx_hash = $2, updated_at = now()
       WHERE decision_id = $1 AND status = 'pending'`,
      [decisionId, txHash]
    );
  }

  /**
   * Confirms a settlement and updates the policy's claim in one transaction, so
   * claim status, the decision row (evidence + tx hash) never diverge.
   */
  async markConfirmed(decisionId: string, policyId: string, txHash: string): Promise<void> {
    const client = await this.db.getClient();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE claim_settlements SET status = 'confirmed', tx_hash = $2, updated_at = now()
         WHERE decision_id = $1 AND status IN ('pending', 'submitted')`,
        [decisionId, txHash]
      );
      if (updated.rowCount === 0) {
        throw new Error(`Settlement ${decisionId} is not open; refusing to confirm`);
      }
      await client.query(
        `UPDATE claims SET status = 'settled', processed_at = now(), settled_at = now(), updated_at = now()
         WHERE policy_id = $1 AND status <> 'settled'`,
        [policyId]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Only for a definitive on-chain rejection. A timeout whose outcome is unknown
   * must stay open for reconciliation instead of being marked failed.
   */
  async markFailed(decisionId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE claim_settlements SET status = 'failed', last_error = $2, updated_at = now()
       WHERE decision_id = $1 AND status = 'pending'`,
      [decisionId, error]
    );
    this.logger.warn(`Settlement ${decisionId} marked failed: ${error}`);
  }
}
