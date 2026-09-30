import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../db/database.service";

export interface IdempotencyRecord {
  key: string;
  endpoint: string;
  responseBody: unknown;
  statusCode: number;
  createdAt: Date;
}

/**
 * Durable idempotency store backed by the `idempotency_keys` Postgres table
 * (see src/db/schema.sql).
 *
 * Callers pass an `Idempotency-Key` header value and their endpoint name.
 * On a first call the service writes a "pending" lock row and the caller
 * proceeds normally; on completion the caller calls `commit()` to persist
 * the response.  On a repeated call (same key + endpoint) the service
 * returns the cached response so the caller never re-executes the write.
 *
 * A "pending" lock older than LOCK_TIMEOUT_MS is considered stale (the
 * original request likely crashed) and is overwritten, allowing the next
 * retry to proceed — this is the same policy Stripe uses for their
 * idempotency keys.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  /** A lock held for longer than this is treated as a stale/crashed request. */
  private static readonly LOCK_TIMEOUT_MS = 60_000;

  constructor(private readonly db: DatabaseService) {}

  /**
   * Attempt to acquire an idempotency lock for `key`.
   *
   * Returns `{ hit: false }` if the key is new (proceed with the write).
   * Returns `{ hit: true, record }` if the key already has a committed
   * response (replay it to the client).
   * Throws `ConflictException` if the key is currently in-flight from
   * another request (caller should respond 409).
   */
  async acquire(
    key: string,
    endpoint: string
  ): Promise<{ hit: false } | { hit: true; record: IdempotencyRecord }> {
    const existing = await this.db.query<{
      key: string;
      endpoint: string;
      response_body: unknown;
      status_code: number;
      created_at: Date;
      committed: boolean;
    }>(
      `SELECT key, endpoint, response_body, status_code, created_at, committed
         FROM idempotency_keys
        WHERE key = $1 AND endpoint = $2`,
      [key, endpoint]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.committed) {
        // Already completed — replay the saved response.
        return {
          hit: true,
          record: {
            key: row.key,
            endpoint: row.endpoint,
            responseBody: row.response_body,
            statusCode: row.status_code,
            createdAt: row.created_at,
          },
        };
      }

      // In-flight: check staleness.
      const ageMs = Date.now() - row.created_at.getTime();
      if (ageMs < IdempotencyService.LOCK_TIMEOUT_MS) {
        throw new ConflictException({
          error: "A request with this Idempotency-Key is already in progress. Retry after it completes.",
          idempotencyKey: key,
        });
      }

      // Stale lock — the original request crashed before committing.
      // Delete and let this request proceed as fresh.
      this.logger.warn(`Stale idempotency lock for key=${key} (age=${ageMs}ms). Proceeding as new request.`);
      await this.db.query(`DELETE FROM idempotency_keys WHERE key = $1 AND endpoint = $2`, [key, endpoint]);
    }

    // Insert a pending lock row.
    await this.db.query(
      `INSERT INTO idempotency_keys (key, endpoint, committed) VALUES ($1, $2, false)
       ON CONFLICT (key, endpoint) DO NOTHING`,
      [key, endpoint]
    );

    return { hit: false };
  }

  /**
   * Commit the final response to the idempotency store so future retries
   * receive a replay instead of re-executing the write.
   */
  async commit(
    key: string,
    endpoint: string,
    responseBody: unknown,
    statusCode = 201
  ): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys
          SET response_body = $3,
              status_code   = $4,
              committed     = true
        WHERE key = $1 AND endpoint = $2`,
      [key, endpoint, JSON.stringify(responseBody), statusCode]
    );
  }

  /**
   * Release a pending lock without committing (e.g. the write failed with an
   * error the client cannot fix by retrying — don't cache the error).
   */
  async release(key: string, endpoint: string): Promise<void> {
    await this.db.query(
      `DELETE FROM idempotency_keys WHERE key = $1 AND endpoint = $2 AND committed = false`,
      [key, endpoint]
    );
  }
}
