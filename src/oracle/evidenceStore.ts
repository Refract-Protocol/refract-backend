import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { OracleReading } from "./oracle-reading";

/** Upper bound on pending reading inserts. Beyond this, readings are dropped and logged. */
const MAX_QUEUE_DEPTH = 1000;
/** Raw payloads are capped so a verbose upstream cannot grow rows without bound. */
const MAX_PAYLOAD_CHARS = 4096;

const SECRET_QUERY_PARAM = /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|secret)=)[^&\s"']+/gi;

export interface ReadingEvidenceInput {
  reading: OracleReading;
  observedAt: Date;
}

export interface DecisionEvidenceInput {
  readingIds: string[];
  chosenValue: number;
  rule: string;
  policyId: string;
  payoutAmount: string;
}

export interface SettlementEvidenceInput {
  status: "confirmed" | "unconfirmed";
  txHash?: string;
}

interface QueuedReading {
  id: string;
  source: string;
  input: ReadingEvidenceInput;
}

/**
 * Single write path for the append-only `oracle_evidence` and
 * `oracle_decisions` tables (see src/db/migrations/004_oracle_evidence.sql).
 * No other module may write these tables directly.
 *
 * Readings are fire-and-forget: they are queued and persisted serially so a
 * slow database never blocks the caller. Decisions are written synchronously
 * and must succeed before a settlement is submitted, so no payout exists
 * without a decision row. Writing a decision first drains the reading queue so
 * the readings it references are present.
 */
@Injectable()
export class EvidenceStore {
  private readonly logger = new Logger(EvidenceStore.name);
  private readonly queue: QueuedReading[] = [];
  private draining: Promise<void> | null = null;

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Queues one reading for persistence and returns its id, or null if the
   * queue is full and the reading was dropped. Never throws or awaits.
   */
  recordReading(input: ReadingEvidenceInput): string | null {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      this.logger.error(`Oracle evidence queue full (${MAX_QUEUE_DEPTH}); dropping ${input.reading.coverageType} reading`);
      return null;
    }

    const id = randomUUID();
    this.queue.push({ id, source: extractSource(input.reading.message), input });
    void this.drain();
    return id;
  }

  /**
   * Persists a decision row. Rejects if the row cannot be written; callers
   * must not submit the settlement in that case.
   */
  async recordDecision(input: DecisionEvidenceInput): Promise<string> {
    await this.drain();

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO oracle_decisions (id, reading_ids, chosen_value, rule, policy_id, payout_amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.readingIds, input.chosenValue, input.rule, input.policyId, input.payoutAmount]
    );
    return id;
  }

  /**
   * Backfills the settlement outcome onto a decision. Failures are logged and
   * not re-thrown: the payout decision is already durable, and the row stays
   * `pending` for later reconciliation.
   */
  async attachSettlement(decisionId: string, outcome: SettlementEvidenceInput): Promise<void> {
    try {
      await this.db.query(
        `UPDATE oracle_decisions
            SET settlement_status = $2, settlement_tx_hash = $3, settled_at = NOW()
          WHERE id = $1`,
        [decisionId, outcome.status, outcome.txHash ?? null]
      );
    } catch (err) {
      this.logger.error(
        `Failed to backfill settlement for decision ${decisionId}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.queue.length === 0) return Promise.resolve();

    this.draining = (async () => {
      while (this.queue.length > 0) {
        const row = this.queue[0];
        try {
          await this.db.query(
            `INSERT INTO oracle_evidence (id, source, coverage_type, normalized_value, raw_payload, observed_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              row.id,
              row.source,
              row.input.reading.coverageType,
              row.input.reading.value,
              toRawPayload(row.input.reading),
              row.input.observedAt,
            ]
          );
        } catch (err) {
          this.logger.error(
            `Failed to persist oracle evidence ${row.id}`,
            err instanceof Error ? err.message : String(err)
          );
        }
        this.queue.shift();
      }
      this.draining = null;
    })();
    return this.draining;
  }
}

/** Serialises the reading without anything beyond its own fields, redacting credentials and capping size. */
function toRawPayload(reading: OracleReading): string {
  const payload = JSON.stringify({
    coverageType: reading.coverageType,
    value: reading.value,
    threshold: reading.threshold,
    severity: reading.severity,
    message: reading.message,
    degraded: reading.degraded ?? false,
  }).replace(SECRET_QUERY_PARAM, "$1[REDACTED]");
  return payload.length > MAX_PAYLOAD_CHARS ? payload.substring(0, MAX_PAYLOAD_CHARS) : payload;
}

/**
 * Extracts a short source tag from the oracle message suffix, e.g.
 * "[CoinGecko]" → "CoinGecko". Mirrors OracleEventRepository.extractSource.
 */
function extractSource(message: string): string {
  const match = /\[([^\]]+)\]/.exec(message);
  if (!match) return "unknown";
  return match[1].split(";")[0].trim().substring(0, 40);
}
