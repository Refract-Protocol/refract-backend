import { Injectable, Logger } from "@nestjs/common";
import { DbService } from "../../db/db.service";

export interface WindowRow {
  id: string;
  feedId: string;
  windowId: string;
  windowStart: Date;
  windowEnd: Date;
  status: "open" | "closed" | "evaluated";
  createdAt: Date;
  closedAt: Date | null;
  evaluatedAt: Date | null;
}

export interface WindowReadingRow {
  id: string;
  windowId: string;
  feedId: string;
  source: string;
  value: number;
  severity: string;
  sourceTimestamp: Date;
  arrivalTimestamp: Date;
  isLate: boolean;
  /** True when this reading was dropped due to lateArrivalPolicy="drop" */
  isDropped: boolean;
  isDuplicate: boolean;
}

export interface ConsensusDecisionRow {
  id: string;
  feedId: string;
  windowId: string;
  windowStart: Date;
  windowEnd: Date;
  readingCount: number;
  lateReadingCount: number;
  value: number;
  severity: string;
  decidedAt: Date;
  /** SHA-256 of the sorted reading IDs — for replay verification. */
  inputHash: string;
}

@Injectable()
export class ConsensusWindowRepository {
  private readonly logger = new Logger(ConsensusWindowRepository.name);

  constructor(private readonly db: DbService) {}

  // ── Windows ───────────────────────────────────────────────────────────────

  async upsertWindow(params: {
    feedId: string;
    windowId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<WindowRow> {
    const { rows } = await this.db.query<WindowRow>(
      `INSERT INTO consensus_windows (feed_id, window_id, window_start, window_end)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (window_id) DO UPDATE SET feed_id = EXCLUDED.feed_id
       RETURNING id, feed_id AS "feedId", window_id AS "windowId",
                 window_start AS "windowStart", window_end AS "windowEnd",
                 status, created_at AS "createdAt",
                 closed_at AS "closedAt", evaluated_at AS "evaluatedAt"`,
      [params.feedId, params.windowId, params.windowStart, params.windowEnd],
    );
    return rows[0];
  }

  async closeWindow(windowId: string): Promise<void> {
    await this.db.query(
      `UPDATE consensus_windows
       SET status = 'closed', closed_at = now()
       WHERE window_id = $1 AND status = 'open'`,
      [windowId],
    );
  }

  async markEvaluated(windowId: string): Promise<void> {
    await this.db.query(
      `UPDATE consensus_windows
       SET status = 'evaluated', evaluated_at = now()
       WHERE window_id = $1`,
      [windowId],
    );
  }

  async getWindow(windowId: string): Promise<WindowRow | null> {
    const { rows } = await this.db.query<WindowRow>(
      `SELECT id, feed_id AS "feedId", window_id AS "windowId",
              window_start AS "windowStart", window_end AS "windowEnd",
              status, created_at AS "createdAt",
              closed_at AS "closedAt", evaluated_at AS "evaluatedAt"
       FROM consensus_windows WHERE window_id = $1`,
      [windowId],
    );
    return rows[0] ?? null;
  }

  /** Returns closed (not yet evaluated) windows for a feed, oldest first. */
  async getClosedUnevaluatedWindows(feedId: string): Promise<WindowRow[]> {
    const { rows } = await this.db.query<WindowRow>(
      `SELECT id, feed_id AS "feedId", window_id AS "windowId",
              window_start AS "windowStart", window_end AS "windowEnd",
              status, created_at AS "createdAt",
              closed_at AS "closedAt", evaluated_at AS "evaluatedAt"
       FROM consensus_windows
       WHERE feed_id = $1 AND status = 'closed'
       ORDER BY window_start ASC`,
      [feedId],
    );
    return rows;
  }

  // ── Readings ──────────────────────────────────────────────────────────────

  /**
   * Insert a reading into a window. Returns null when the reading is a
   * duplicate (same source already present in this window).
   */
  async insertReading(params: {
    windowId: string;
    feedId: string;
    source: string;
    value: number;
    severity: string;
    sourceTimestamp: Date;
    arrivalTimestamp: Date;
    isLate: boolean;
    isDropped: boolean;
  }): Promise<WindowReadingRow | null> {
    try {
      const { rows } = await this.db.query<WindowReadingRow>(
        `INSERT INTO consensus_window_readings
           (window_id, feed_id, source, value, severity,
            source_timestamp, arrival_timestamp, is_late, is_dropped)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (window_id, source) DO NOTHING
         RETURNING id, window_id AS "windowId", feed_id AS "feedId",
                   source, value, severity,
                   source_timestamp AS "sourceTimestamp",
                   arrival_timestamp AS "arrivalTimestamp",
                   is_late AS "isLate", is_dropped AS "isDropped",
                   is_duplicate AS "isDuplicate"`,
        [
          params.windowId,
          params.feedId,
          params.source,
          params.value,
          params.severity,
          params.sourceTimestamp,
          params.arrivalTimestamp,
          params.isLate,
          params.isDropped,
        ],
      );
      return rows[0] ?? null; // null = duplicate (ON CONFLICT DO NOTHING)
    } catch (err) {
      this.logger.error(
        `Failed to insert window reading for ${params.feedId}`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /** Returns all non-dropped readings for a window, sorted by source for determinism. */
  async getEligibleReadings(windowId: string): Promise<WindowReadingRow[]> {
    const { rows } = await this.db.query<WindowReadingRow>(
      `SELECT id, window_id AS "windowId", feed_id AS "feedId",
              source, value, severity,
              source_timestamp AS "sourceTimestamp",
              arrival_timestamp AS "arrivalTimestamp",
              is_late AS "isLate", is_dropped AS "isDropped",
              is_duplicate AS "isDuplicate"
       FROM consensus_window_readings
       WHERE window_id = $1 AND is_dropped = false
       ORDER BY source ASC`,
      [windowId],
    );
    return rows;
  }

  async getAllReadings(windowId: string): Promise<WindowReadingRow[]> {
    const { rows } = await this.db.query<WindowReadingRow>(
      `SELECT id, window_id AS "windowId", feed_id AS "feedId",
              source, value, severity,
              source_timestamp AS "sourceTimestamp",
              arrival_timestamp AS "arrivalTimestamp",
              is_late AS "isLate", is_dropped AS "isDropped",
              is_duplicate AS "isDuplicate"
       FROM consensus_window_readings
       WHERE window_id = $1
       ORDER BY source ASC`,
      [windowId],
    );
    return rows;
  }

  // ── Consensus decisions ───────────────────────────────────────────────────

  async recordDecision(params: {
    feedId: string;
    windowId: string;
    windowStart: Date;
    windowEnd: Date;
    readingCount: number;
    lateReadingCount: number;
    value: number;
    severity: string;
    inputHash: string;
  }): Promise<ConsensusDecisionRow> {
    const { rows } = await this.db.query<ConsensusDecisionRow>(
      `INSERT INTO consensus_decisions
         (feed_id, window_id, window_start, window_end,
          reading_count, late_reading_count, value, severity, input_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (window_id) DO UPDATE
         SET value = EXCLUDED.value,
             severity = EXCLUDED.severity,
             reading_count = EXCLUDED.reading_count,
             late_reading_count = EXCLUDED.late_reading_count,
             input_hash = EXCLUDED.input_hash,
             decided_at = now()
       RETURNING id, feed_id AS "feedId", window_id AS "windowId",
                 window_start AS "windowStart", window_end AS "windowEnd",
                 reading_count AS "readingCount",
                 late_reading_count AS "lateReadingCount",
                 value, severity, decided_at AS "decidedAt",
                 input_hash AS "inputHash"`,
      [
        params.feedId,
        params.windowId,
        params.windowStart,
        params.windowEnd,
        params.readingCount,
        params.lateReadingCount,
        params.value,
        params.severity,
        params.inputHash,
      ],
    );
    return rows[0];
  }

  async getDecision(windowId: string): Promise<ConsensusDecisionRow | null> {
    const { rows } = await this.db.query<ConsensusDecisionRow>(
      `SELECT id, feed_id AS "feedId", window_id AS "windowId",
              window_start AS "windowStart", window_end AS "windowEnd",
              reading_count AS "readingCount",
              late_reading_count AS "lateReadingCount",
              value, severity, decided_at AS "decidedAt",
              input_hash AS "inputHash"
       FROM consensus_decisions WHERE window_id = $1`,
      [windowId],
    );
    return rows[0] ?? null;
  }
}
