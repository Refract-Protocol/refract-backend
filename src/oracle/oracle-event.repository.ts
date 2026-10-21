import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { EVIDENCE_COVERAGE_TYPES, EvidenceRecord, EvidenceStore, isGap } from "./evidence/evidence-record";

/**
 * Postgres system of record for the oracle evidence trail (`oracle_events`
 * plus `oracle_evidence_gaps`, see src/db/migrations/004_oracle_evidence_sequence.sql).
 *
 * Callers do not write here directly: OracleEvidenceBuffer spools records
 * locally first and calls `persist` in seq order. `persist` therefore
 * throws on failure (so the buffer keeps the batch and retries) and is
 * idempotent per seq (so a replay after a crash is harmless).
 */
@Injectable()
export class OracleEventRepository implements EvidenceStore {
  constructor(private readonly db: DbService) {}

  async persist(records: EvidenceRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        for (const record of records) {
          if (isGap(record)) {
            await client.query(
              `INSERT INTO oracle_evidence_gaps (seq, first_seq, last_seq, lost_count, opened_at, closed_at, reason)
               VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), $7)
               ON CONFLICT (seq) DO NOTHING`,
              [record.seq, record.firstSeq, record.lastSeq, record.lostCount, record.openedAt, record.closedAt, record.reason.slice(0, 500)],
            );
            continue;
          }
          const coverageType = EVIDENCE_COVERAGE_TYPES[record.coverageType];
          if (!coverageType) {
            // Rejected at append time; reaching here means a corrupted spool
            // entry. Fail loudly instead of silently skipping evidence.
            throw new Error(`seq ${record.seq}: unknown coverageType "${record.coverageType}"`);
          }
          await client.query(
            `INSERT INTO oracle_events (seq, kind, coverage_type, value, source, severity, payload, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
             ON CONFLICT (seq, recorded_at) DO NOTHING`,
            [
              record.seq,
              record.kind,
              coverageType,
              record.value,
              record.source.slice(0, 40),
              record.severity,
              JSON.stringify(record.payload),
              record.recordedAt,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
  }
}
