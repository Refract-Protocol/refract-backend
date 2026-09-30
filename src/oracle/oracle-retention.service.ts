import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DatabaseService } from "../db/database.service";

/**
 * Manages the lifecycle of oracle_events monthly partitions:
 *
 *  1. Proactive creation  — ensures the current and next two calendar months
 *     always have a partition, run daily at 01:00 UTC.
 *  2. Retention sweep     — detaches (and drops) partitions older than
 *     RETENTION_MONTHS (default 6 months), run daily at 02:00 UTC.
 *  3. Idempotency cleanup — purges committed idempotency_keys older than
 *     24 hours, run daily at 03:00 UTC.
 *
 * All three jobs run inside their own try/catch so a failure in one doesn't
 * silence the others, and each is independently logged.
 */
@Injectable()
export class OracleRetentionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OracleRetentionService.name);

  /**
   * Months of oracle_events partitions to keep before detaching/dropping.
   * Tunable via DB_ORACLE_RETENTION_MONTHS env (picked up in
   * configuration.ts when the database section is extended — left as a
   * plain constant here to avoid coupling this service to AppConfig
   * changes for a single scalar).
   */
  private readonly retentionMonths =
    parseInt(process.env.DB_ORACLE_RETENTION_MONTHS ?? "6", 10);

  constructor(private readonly db: DatabaseService) {}

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  async onApplicationBootstrap(): Promise<void> {
    // Ensure partitions exist for the current + next two months on every
    // startup without waiting for the nightly cron — covers fresh deploys
    // and restarts just before midnight on the last day of a month.
    await this.ensureUpcomingPartitions().catch((err) =>
      this.logger.error("Bootstrap partition creation failed", err instanceof Error ? err.stack : err)
    );
  }

  // ─── Scheduled jobs ───────────────────────────────────────────────────────

  /** Daily at 01:00 UTC — create partitions for current + next two months. */
  @Cron("0 1 * * *")
  async ensureUpcomingPartitions(): Promise<void> {
    const created: string[] = [];
    try {
      for (let offset = 0; offset <= 2; offset++) {
        const partStart = addMonths(startOfMonth(new Date()), offset);
        const partEnd = addMonths(partStart, 1);
        const name = partitionName(partStart);

        const exists = await this.partitionExists(name);
        if (!exists) {
          await this.createPartition(name, partStart, partEnd);
          created.push(name);
        }
      }
      if (created.length > 0) {
        this.logger.log(`Created oracle_events partitions: ${created.join(", ")}`);
      }
    } catch (err) {
      this.logger.error("ensureUpcomingPartitions failed", err instanceof Error ? err.stack : err);
    }
  }

  /** Daily at 02:00 UTC — drop partitions outside the retention window. */
  @Cron("0 2 * * *")
  async pruneOldPartitions(): Promise<void> {
    const dropped: string[] = [];
    try {
      const cutoff = addMonths(startOfMonth(new Date()), -this.retentionMonths);

      // List all oracle_events child partitions older than the cutoff.
      const { rows } = await this.db.query<{ relname: string; part_start: Date }>(
        `SELECT c.relname,
                (regexp_match(c.relname, E'oracle_events_(\\\\d{4})_(\\\\d{2})'))[1]::text AS year,
                (regexp_match(c.relname, E'oracle_events_(\\\\d{4})_(\\\\d{2})'))[2]::text AS month
           FROM pg_inherits i
           JOIN pg_class c  ON c.oid = i.inhrelid
           JOIN pg_class p  ON p.oid = i.inhparent
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE p.relname = 'oracle_events'
            AND n.nspname = 'public'
            AND c.relname ~ E'^oracle_events_\\\\d{4}_\\\\d{2}$'`
      );

      for (const row of rows) {
        const match = row.relname.match(/oracle_events_(\d{4})_(\d{2})/);
        if (!match) continue;
        const partDate = new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, 1);
        if (partDate < cutoff) {
          await this.db.query(`DROP TABLE IF EXISTS ${row.relname}`);
          dropped.push(row.relname);
          this.logger.warn(`Dropped oracle_events partition ${row.relname} (older than ${this.retentionMonths} months)`);
        }
      }
      if (dropped.length === 0) {
        this.logger.debug("No oracle_events partitions outside retention window");
      }
    } catch (err) {
      this.logger.error("pruneOldPartitions failed", err instanceof Error ? err.stack : err);
    }
  }

  /** Daily at 03:00 UTC — purge stale idempotency_keys rows. */
  @Cron("0 3 * * *")
  async purgeStaleIdempotencyKeys(): Promise<void> {
    try {
      const result = await this.db.query(
        `DELETE FROM idempotency_keys
          WHERE created_at < NOW() - INTERVAL '24 hours'`
      );
      const count = result.rowCount ?? 0;
      if (count > 0) {
        this.logger.log(`Purged ${count} stale idempotency_keys row(s)`);
      }
    } catch (err) {
      this.logger.error("purgeStaleIdempotencyKeys failed", err instanceof Error ? err.stack : err);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async partitionExists(name: string): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = 'public'
       ) AS exists`,
      [name]
    );
    return rows[0]?.exists ?? false;
  }

  private async createPartition(name: string, start: Date, end: Date): Promise<void> {
    const startIso = toIso(start);
    const endIso = toIso(end);
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${name}
         PARTITION OF oracle_events
         FOR VALUES FROM ('${startIso}') TO ('${endIso}')`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS idx_${name}_type ON ${name} (coverage_type, recorded_at DESC)`
    );
  }
}

// ─── Date helpers (no external dependency) ───────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + n);
  return result;
}

function partitionName(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  return `oracle_events_${y}_${m}`;
}

function toIso(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}-01`;
}
