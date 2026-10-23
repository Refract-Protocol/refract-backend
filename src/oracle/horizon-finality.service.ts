import { Injectable, Logger } from "@nestjs/common";
import { PoolClient } from "pg";
import { DbService } from "../db/db.service";

export const HORIZON_CHECKPOINT_KEY = "horizon_readings";
export const DEFAULT_FINALITY_DEPTH = 5;

export type FinalityPolicy = "final_only" | "allow_provisional";
export type ReadingFinality = "provisional" | "final" | "invalidated";

export interface HorizonReadingInput {
  coverageType: string;
  value: number;
  ledgerSequence: number;
  ledgerHash: string;
  source?: string;
}

export interface HorizonReadingRow {
  id: number;
  coverageType: string;
  value: number;
  ledgerSequence: number;
  ledgerHash: string;
  finality: ReadingFinality;
}

export interface ReorgResult {
  reorged: boolean;
  /** Sequence at which the stored hash diverged from Horizon's. */
  ledgerSequence?: number;
  invalidatedReadingIds: number[];
  supersededDecisionIds: number[];
}

/**
 * Finality model for Horizon-derived oracle readings.
 *
 * Readings are stored `provisional` with the ledger sequence + hash they were
 * derived from. They are promoted to `final` once the latest observed ledger is
 * at least `depth` ledgers ahead AND the stored hash for their ledger still
 * matches. Reorgs are detected by comparing hashes, not by a flag: a changed
 * hash at a known sequence (or a `prev_hash` that disagrees with the stored
 * parent) invalidates readings on that ledger only, supersedes any decision
 * that used them, rewinds the checkpoint, and appends to
 * `oracle_evidence_ledger` — nothing is deleted.
 *
 * Promotion depends only on the newest ledger seen, so a lagging Horizon never
 * blocks ingestion; readings simply stay provisional (and ineligible under the
 * default `final_only` policy) until it catches up.
 */
@Injectable()
export class HorizonFinalityService {
  private readonly logger = new Logger(HorizonFinalityService.name);
  private readonly depth: number;
  private readonly policy: FinalityPolicy;

  constructor(private readonly db: DbService) {
    const depth = Number(process.env.HORIZON_FINALITY_DEPTH ?? DEFAULT_FINALITY_DEPTH);
    this.depth = Number.isInteger(depth) && depth >= 0 ? depth : DEFAULT_FINALITY_DEPTH;
    this.policy =
      process.env.HORIZON_FINALITY_POLICY === "allow_provisional" ? "allow_provisional" : "final_only";
  }

  getPolicy(): FinalityPolicy {
    return this.policy;
  }

  getDepth(): number {
    return this.depth;
  }

  /** Stores a reading as provisional, tagged with its source ledger. */
  async recordReading(input: HorizonReadingInput): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO horizon_readings (coverage_type, source, value, ledger_sequence, ledger_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.coverageType, input.source ?? "Horizon", input.value, input.ledgerSequence, input.ledgerHash]
    );
    return Number(result.rows[0].id);
  }

  /**
   * Records a ledger observed from Horizon and runs reorg detection against
   * what was stored previously. `prevHash` lets a reorg of the parent be caught
   * even if the parent sequence is not re-polled.
   */
  async observeLedger(
    sequence: number,
    hash: string,
    prevHash?: string | null,
    closedAt?: Date | null
  ): Promise<ReorgResult> {
    return this.db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result: ReorgResult = { reorged: false, invalidatedReadingIds: [], supersededDecisionIds: [] };

        const existing = await client.query<{ hash: string }>(
          "SELECT hash FROM horizon_ledgers WHERE sequence = $1 FOR UPDATE",
          [sequence]
        );
        const stored = existing.rows[0]?.hash;
        if (stored && stored !== hash) {
          await this.handleReorg(client, sequence, stored, hash, result);
        }

        if (prevHash && sequence > 1) {
          const parent = await client.query<{ hash: string }>(
            "SELECT hash FROM horizon_ledgers WHERE sequence = $1 FOR UPDATE",
            [sequence - 1]
          );
          const parentHash = parent.rows[0]?.hash;
          if (parentHash && parentHash !== prevHash) {
            await this.handleReorg(client, sequence - 1, parentHash, prevHash, result);
          }
        }

        await client.query(
          `INSERT INTO horizon_ledgers (sequence, hash, prev_hash, closed_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (sequence) DO UPDATE
             SET hash = EXCLUDED.hash, prev_hash = EXCLUDED.prev_hash,
                 closed_at = EXCLUDED.closed_at, observed_at = NOW()`,
          [sequence, hash, prevHash ?? null, closedAt ?? null]
        );

        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Promotes provisional readings whose ledger is at least `depth` behind
   * `latestLedger` and whose hash still matches the stored ledger, then
   * advances the checkpoint. Returns the promoted reading ids.
   */
  async promoteFinalized(latestLedger: number): Promise<number[]> {
    const finalizedUpTo = latestLedger - this.depth;
    if (finalizedUpTo < 1) return [];

    return this.db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const promoted = await client.query<{ id: string }>(
          `UPDATE horizon_readings r
              SET finality = 'final', finalized_at = NOW()
             FROM horizon_ledgers l
            WHERE r.finality = 'provisional'
              AND r.ledger_sequence <= $1
              AND l.sequence = r.ledger_sequence
              AND l.hash = r.ledger_hash
            RETURNING r.id`,
          [finalizedUpTo]
        );

        const finalLedger = await client.query<{ hash: string }>(
          "SELECT hash FROM horizon_ledgers WHERE sequence = $1",
          [finalizedUpTo]
        );
        await client.query(
          `INSERT INTO horizon_ingest_checkpoints (checkpoint_key, last_final_ledger, last_final_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (checkpoint_key) DO UPDATE
             SET last_final_ledger = GREATEST(horizon_ingest_checkpoints.last_final_ledger, EXCLUDED.last_final_ledger),
                 last_final_hash = CASE
                   WHEN EXCLUDED.last_final_ledger >= horizon_ingest_checkpoints.last_final_ledger
                     THEN EXCLUDED.last_final_hash
                   ELSE horizon_ingest_checkpoints.last_final_hash END,
                 updated_at = NOW()`,
          [HORIZON_CHECKPOINT_KEY, finalizedUpTo, finalLedger.rows[0]?.hash ?? null]
        );

        await client.query("COMMIT");
        return promoted.rows.map((row) => Number(row.id));
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  /**
   * First ledger a restarted poller should fetch: just after the last final
   * ledger. Null when nothing has been finalized yet (use the configured start).
   */
  async getResumeLedger(): Promise<number | null> {
    const result = await this.db.query<{ last_final_ledger: string }>(
      "SELECT last_final_ledger FROM horizon_ingest_checkpoints WHERE checkpoint_key = $1",
      [HORIZON_CHECKPOINT_KEY]
    );
    const row = result.rows[0];
    return row ? Number(row.last_final_ledger) + 1 : null;
  }

  /** Readings that may count toward quorum under the configured policy. */
  async getQuorumEligibleReadings(coverageType: string): Promise<HorizonReadingRow[]> {
    const finalities: ReadingFinality[] =
      this.policy === "final_only" ? ["final"] : ["final", "provisional"];
    const result = await this.db.query<{
      id: string;
      coverage_type: string;
      value: string;
      ledger_sequence: string;
      ledger_hash: string;
      finality: ReadingFinality;
    }>(
      `SELECT id, coverage_type, value, ledger_sequence, ledger_hash, finality
         FROM horizon_readings
        WHERE coverage_type = $1 AND finality = ANY($2::text[])
        ORDER BY ledger_sequence DESC, id DESC`,
      [coverageType, finalities]
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      coverageType: row.coverage_type,
      value: Number(row.value),
      ledgerSequence: Number(row.ledger_sequence),
      ledgerHash: row.ledger_hash,
      finality: row.finality,
    }));
  }

  /**
   * Records a consensus decision and links the readings it relied on. Rejects
   * readings that are not quorum-eligible under the configured policy, so a
   * payout-triggering decision can never be built on provisional data by
   * default.
   */
  async recordDecision(coverageType: string, readingIds: number[]): Promise<number> {
    if (readingIds.length === 0) {
      throw new Error("A decision must reference at least one reading");
    }
    const allowed = this.policy === "final_only" ? ["final"] : ["final", "provisional"];
    return this.db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const readings = await client.query<{ id: string; finality: ReadingFinality }>(
          "SELECT id, finality FROM horizon_readings WHERE id = ANY($1::bigint[]) FOR UPDATE",
          [readingIds]
        );
        const ineligible = readings.rows.filter((row) => !allowed.includes(row.finality));
        if (readings.rows.length !== new Set(readingIds).size || ineligible.length > 0) {
          throw new Error(
            `Readings not eligible under "${this.policy}" policy: ${
              ineligible.map((row) => `${row.id}(${row.finality})`).join(", ") || "unknown ids"
            }`
          );
        }
        const decision = await client.query<{ id: string }>(
          "INSERT INTO oracle_decisions (coverage_type) VALUES ($1) RETURNING id",
          [coverageType]
        );
        const decisionId = Number(decision.rows[0].id);
        await client.query("UPDATE horizon_readings SET decision_id = $1 WHERE id = ANY($2::bigint[])", [
          decisionId,
          readingIds,
        ]);
        await client.query("COMMIT");
        return decisionId;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  private async handleReorg(
    client: PoolClient,
    sequence: number,
    oldHash: string,
    newHash: string,
    result: ReorgResult
  ): Promise<void> {
    this.logger.warn(`Ledger reorg at #${sequence}: ${oldHash} -> ${newHash}`);
    result.reorged = true;
    result.ledgerSequence = sequence;

    await client.query(
      `INSERT INTO oracle_evidence_ledger (event_type, ledger_sequence, old_hash, new_hash)
       VALUES ('LEDGER_REORG', $1, $2, $3)`,
      [sequence, oldHash, newHash]
    );

    // Only readings tied to the superseded hash are affected; readings on the
    // new hash (or other ledgers) are untouched.
    const affected = await client.query<{ id: string; decision_id: string | null }>(
      `UPDATE horizon_readings
          SET finality = 'invalidated', invalidated_at = NOW()
        WHERE ledger_sequence = $1 AND ledger_hash <> $2 AND finality <> 'invalidated'
        RETURNING id, decision_id`,
      [sequence, newHash]
    );

    const decisionIds = new Set<number>();
    for (const row of affected.rows) {
      const readingId = Number(row.id);
      result.invalidatedReadingIds.push(readingId);
      await client.query(
        `INSERT INTO oracle_evidence_ledger (event_type, ledger_sequence, reading_id, old_hash, new_hash)
         VALUES ('READING_INVALIDATED', $1, $2, $3, $4)`,
        [sequence, readingId, oldHash, newHash]
      );
      if (row.decision_id) decisionIds.add(Number(row.decision_id));
    }

    for (const decisionId of decisionIds) {
      const updated = await client.query(
        `UPDATE oracle_decisions
            SET status = 'superseded', superseded_at = NOW(), superseded_reason = $2
          WHERE id = $1 AND status = 'active'`,
        [decisionId, `Ledger #${sequence} reorged (${oldHash} -> ${newHash})`]
      );
      if ((updated.rowCount ?? 0) > 0) {
        result.supersededDecisionIds.push(decisionId);
        await client.query(
          `INSERT INTO oracle_evidence_ledger (event_type, ledger_sequence, decision_id, old_hash, new_hash)
           VALUES ('DECISION_SUPERSEDED', $1, $2, $3, $4)`,
          [sequence, decisionId, oldHash, newHash]
        );
      }
    }

    // Never resume from a ledger that is no longer canonical.
    await client.query(
      `UPDATE horizon_ingest_checkpoints
          SET last_final_ledger = $2, last_final_hash = NULL, updated_at = NOW()
        WHERE checkpoint_key = $1 AND last_final_ledger >= $3`,
      [HORIZON_CHECKPOINT_KEY, Math.max(sequence - 1, 0), sequence]
    );

    await client.query(
      "UPDATE horizon_ledgers SET hash = $2, observed_at = NOW() WHERE sequence = $1",
      [sequence, newHash]
    );
  }
}
