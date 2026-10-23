import { Injectable } from "@nestjs/common";
import { COVERAGE_TYPE_PG } from "../common/coverage-type.map";
import { DbService } from "../db/db.service";
import { SUBMISSION_MAX_AGE_MS, VerifiedSubmission } from "./submission-verifier";

/**
 * Writes verified third-party submissions to the `oracle_submissions` evidence
 * table (see migrations/002_oracle_submissions.sql). Called only after
 * SubmissionVerifier has accepted the payload.
 */
@Injectable()
export class OracleSubmissionRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Claims the nonce and records the submission in one transaction. Returns
   * false, writing nothing, when the (provider, nonce) pair was already used.
   *
   * A nonce only needs remembering until its observed_at ages out of the
   * freshness window, so its TTL is observed_at + SUBMISSION_MAX_AGE_MS.
   */
  async recordIfNonceUnused(submission: VerifiedSubmission): Promise<boolean> {
    const expiresAt = new Date(submission.observedAt.getTime() + SUBMISSION_MAX_AGE_MS);

    return this.db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`DELETE FROM oracle_submission_nonces WHERE expires_at < now()`);

        const claimed = await client.query(
          `INSERT INTO oracle_submission_nonces (provider_id, nonce, expires_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (provider_id, nonce) DO NOTHING`,
          [submission.providerId, submission.nonce, expiresAt],
        );
        if (claimed.rowCount === 0) {
          await client.query("ROLLBACK");
          return false;
        }

        await client.query(
          `INSERT INTO oracle_submissions
             (provider_id, nonce, coverage_type, value, unit, observed_at, signature)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            submission.providerId,
            submission.nonce,
            COVERAGE_TYPE_PG[submission.coverageType],
            submission.value,
            submission.unit,
            submission.observedAt,
            submission.signature,
          ],
        );
        await client.query("COMMIT");
        return true;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }
}
