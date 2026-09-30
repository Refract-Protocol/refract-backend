import { Inject, Injectable } from "@nestjs/common";
import { Pool as PostgresPool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

export type RelayerTransactionStatus = "signed" | "submitted" | "rejected" | "confirmed" | "failed";

@Injectable()
export class RelayerAuditService {
  constructor(@Inject(DATABASE_POOL) private readonly database: PostgresPool) {}

  async recordSignedTransaction(policyId: string, signerPublicKey: string, transactionHash: string): Promise<void> {
    await this.database.query(
      `INSERT INTO relayer_transaction_audit
        (transaction_hash, policy_id, signer_public_key, status)
       VALUES ($1, $2, $3, 'signed')`,
      [transactionHash, policyId, signerPublicKey]
    );
  }

  async recordOutcome(
    transactionHash: string,
    status: RelayerTransactionStatus,
    submissionStatus?: string,
    errorMessage?: string
  ): Promise<void> {
    const result = await this.database.query(
      `UPDATE relayer_transaction_audit
       SET status = $2,
           submission_status = $3,
           error_message = $4,
           submitted_at = CASE WHEN $2 = 'submitted' THEN NOW() ELSE submitted_at END,
           completed_at = CASE WHEN $2 IN ('rejected', 'confirmed', 'failed') THEN NOW() ELSE completed_at END,
           updated_at = NOW()
       WHERE transaction_hash = $1`,
      [transactionHash, status, submissionStatus ?? null, errorMessage ?? null]
    );
    if (result.rowCount !== 1) {
      throw new Error(`Relayer audit record not found for transaction ${transactionHash}`);
    }
  }
}
