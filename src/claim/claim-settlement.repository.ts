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

export interface SettlementAttemptUpsert {
  policyId: string;
  holder: string;
  attemptCount: number;
  lastError?: string;
  lastErrorClass?: "transient" | "permanent" | "indeterminate";
  pendingTxHash?: string;
  errorHistory: unknown[];
}

const UNIQUE_VIOLATION = "23505";

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
   * Persists attempt-count/error-history updates for several policies in one
   * round trip instead of one UPSERT per policy. The attempt-counter-cap
   * decision (how many attempts a policy gets) is made by the caller before
   * this is invoked; this only writes whatever rows it is given.
   */
  async recordAttemptsBatch(attempts: SettlementAttemptUpsert[]): Promise<void> {
    if (attempts.length === 0) return;

    const columns = ["policy_id", "holder", "attempt_count", "last_error", "last_error_class", "pending_tx_hash", "error_history"];
    const values: unknown[] = [];
    const rows = attempts.map((attempt, i) => {
      const base = i * columns.length;
      values.push(
        attempt.policyId,
        attempt.holder,
        attempt.attemptCount,
        attempt.lastError ?? null,
        attempt.lastErrorClass ?? null,
        attempt.pendingTxHash ?? null,
        JSON.stringify(attempt.errorHistory)
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`;
    });

    await this.db.query(
      `INSERT INTO settlement_attempts (policy_id, holder, attempt_count, last_error, last_error_class, pending_tx_hash, error_history)
       VALUES ${rows.join(", ")}
       ON CONFLICT (policy_id) DO UPDATE SET
         attempt_count = EXCLUDED.attempt_count,
         last_attempt_at = now(),
         last_error = EXCLUDED.last_error,
         last_error_class = EXCLUDED.last_error_class,
         pending_tx_hash = EXCLUDED.pending_tx_hash,
         error_history = EXCLUDED.error_history,
         updated_at = now()`,
      values
    );
  }

  async findByDecisionId(decisionId: string): Promise<ClaimSettlementRecord | null> {
    const result = await this.db.query<ClaimSettlementRecord>(
      `SELECT decision_id AS "decisionId", policy_id AS "policyId", amount::text AS amount,
              status, tx_hash AS "txHash", last_error AS "lastError"
       FROM claim_settlements WHERE decision_id = $1`,
      [decisionId]
    );
    return result.rows[0] ?? null;
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
