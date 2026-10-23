import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { OracleEventRepository } from "./oracle-event.repository";
import { OracleReading } from "./oracle-reading";

export type ReplayOutcome = "inserted" | "duplicate" | "rejected";

export interface DeadLetterRow {
  id: string;
  coverage_type: string;
  source: string;
  window_start: Date;
  window_end: Date;
  error_class: string;
  error_message: string | null;
  payload: OracleReading | null;
  attempts: number;
}

/**
 * Persists oracle readings that failed validation or persistence to the
 * `oracle_dead_letters` table (see src/db/migrations/004_oracle_dead_letter_queue.sql).
 *
 * Replay is keyed by dead-letter id: each row is locked with FOR UPDATE and
 * skipped once replayed_at is set, so re-running a replay never inserts twice.
 * A replay never overwrites an existing reading for the same coverage type,
 * source and observation window.
 */
@Injectable()
export class OracleDeadLetterRepository {
  private readonly logger = new Logger(OracleDeadLetterRepository.name);

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Records one dead letter per reading. Fire-and-forget like the readings
   * path: errors are logged but never re-thrown.
   */
  async enqueue(readings: OracleReading[], errorClass: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const windowStart = new Date();

    for (const reading of readings) {
      try {
        await this.db.query(
          `INSERT INTO oracle_dead_letters
             (coverage_type, source, window_start, window_end, error_class, error_message, payload)
           VALUES ($1, $2, $3, $3, $4, $5, $6)`,
          [
            reading.coverageType,
            OracleEventRepository.extractSource(reading.message),
            windowStart,
            errorClass,
            errorMessage,
            JSON.stringify(reading),
          ]
        );
      } catch (err) {
        this.logger.error(
          `Failed to dead-letter oracle reading for ${reading.coverageType}`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /** Number of dead letters not yet replayed. Exposed for metrics and logs. */
  async depth(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM oracle_dead_letters WHERE replayed_at IS NULL`
    );
    return parseInt(rows[0].count, 10);
  }

  /**
   * Replays one dead letter through the oracle_events insert path. Returns
   * "rejected" (row stays pending) when the payload is missing or the
   * coverage type still cannot be mapped.
   */
  async replay(id: string): Promise<ReplayOutcome | "not_found"> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<DeadLetterRow>(
        `SELECT id, coverage_type, source, window_start, window_end,
                error_class, error_message, payload, attempts
           FROM oracle_dead_letters
          WHERE id = $1 AND replayed_at IS NULL
          FOR UPDATE`,
        [id]
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return "not_found";
      }

      const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[row.coverage_type];
      if (!row.payload || !coverageType) {
        const reason = row.payload ? "UnknownCoverageType" : "PayloadMissing";
        await client.query(
          `UPDATE oracle_dead_letters
              SET attempts = attempts + 1, error_class = $2, error_message = $3
            WHERE id = $1`,
          [id, reason, `Replay rejected: ${reason}`]
        );
        await client.query("COMMIT");
        return "rejected";
      }

      // Dedup on (coverage_type, source, observation window). The window
      // start is used as recorded_at so the same window always maps to the
      // same key.
      const inserted = await client.query(
        `INSERT INTO oracle_events
           (coverage_type, value, source, severity, recorded_at, replayed_from_dead_letter_id)
         SELECT $1::coverage_type, $2::numeric, $3::varchar, $4::varchar, $5::timestamptz, $6::bigint
          WHERE NOT EXISTS (
            SELECT 1 FROM oracle_events
             WHERE coverage_type = $1::coverage_type
               AND source = $3::varchar
               AND recorded_at = $5::timestamptz
          )`,
        [
          coverageType,
          row.payload.value,
          row.source,
          row.payload.severity,
          row.window_start,
          id,
        ]
      );

      const outcome: ReplayOutcome = inserted.rowCount ? "inserted" : "duplicate";
      await client.query(
        `UPDATE oracle_dead_letters
            SET attempts = attempts + 1, replay_outcome = $2, replayed_at = NOW()
          WHERE id = $1`,
        [id, outcome]
      );
      await client.query("COMMIT");
      return outcome;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Replays up to `limit` pending dead letters in id order and logs the
   * outcome counts. A failing row is logged and skipped so one bad row
   * cannot block the rest of the queue.
   */
  async replayPending(limit = 100): Promise<Record<ReplayOutcome | "failed", number>> {
    const counts: Record<ReplayOutcome | "failed", number> = {
      inserted: 0,
      duplicate: 0,
      rejected: 0,
      failed: 0,
    };

    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM oracle_dead_letters WHERE replayed_at IS NULL ORDER BY id LIMIT $1`,
      [limit]
    );

    for (const { id } of rows) {
      try {
        const outcome = await this.replay(id);
        if (outcome === "not_found") continue;
        counts[outcome] += 1;
      } catch (err) {
        counts.failed += 1;
        this.logger.error(
          `Replay of dead letter ${id} failed`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    this.logger.log(
      `Oracle dead-letter replay: inserted=${counts.inserted} duplicate=${counts.duplicate} ` +
        `rejected=${counts.rejected} failed=${counts.failed}`
    );
    return counts;
  }

  /** Deletes replayed dead letters older than `retentionDays`. Returns rows removed. */
  async purgeReplayed(retentionDays: number): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM oracle_dead_letters
        WHERE replayed_at IS NOT NULL
          AND replayed_at < NOW() - make_interval(days => $1::int)`,
      [retentionDays]
    );
    return result.rowCount ?? 0;
  }
}
