import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

export const DEFAULT_CURSOR_KEY = "soroban_events";

export interface IndexerCursor {
  cursorKey: string;
  lastLedger: number;
  lastEventId: string;
  updatedAt: Date | null;
}

/**
 * Persists the Soroban event-indexer resume point and idempotency keys.
 */
@Injectable()
export class IndexerCursorRepository {
  constructor(private readonly db: DbService) {}

  async getCursor(cursorKey: string = DEFAULT_CURSOR_KEY): Promise<IndexerCursor> {
    const result = await this.db.query<{
      cursor_key: string;
      last_ledger: string;
      last_event_id: string;
      updated_at: Date | null;
    }>("SELECT cursor_key, last_ledger, last_event_id, updated_at FROM indexer_cursors WHERE cursor_key = $1", [
      cursorKey,
    ]);

    const row = result.rows[0];
    if (!row) {
      return { cursorKey, lastLedger: 0, lastEventId: "", updatedAt: null };
    }
    return {
      cursorKey: row.cursor_key,
      lastLedger: Number(row.last_ledger),
      lastEventId: row.last_event_id ?? "",
      updatedAt: row.updated_at,
    };
  }

  async saveCursor(
    lastLedger: number,
    lastEventId: string,
    cursorKey: string = DEFAULT_CURSOR_KEY
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO indexer_cursors (cursor_key, last_ledger, last_event_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (cursor_key) DO UPDATE
         SET last_ledger = EXCLUDED.last_ledger,
             last_event_id = EXCLUDED.last_event_id,
             updated_at = NOW()`,
      [cursorKey, lastLedger, lastEventId]
    );
  }

  async hasProcessed(eventId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM processed_events WHERE event_id = $1) AS exists",
      [eventId]
    );
    return Boolean(result.rows[0]?.exists);
  }

  /**
   * Records an event as processed. Returns false when the row already existed
   * (unique violation / ON CONFLICT DO NOTHING), so callers can skip projection.
   */
  async tryMarkProcessed(input: {
    eventId: string;
    ledger: number;
    topic: string;
    contractId?: string;
    txHash?: string;
  }): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO processed_events (event_id, ledger, topic, contract_id, tx_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING`,
      [input.eventId, input.ledger, input.topic, input.contractId ?? null, input.txHash ?? null]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
