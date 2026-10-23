import { HistoricalSample, SourceBaseline } from "./baseline";

/**
 * Bootstrap lifecycle of one (feed, source) pair:
 *
 *  - `cold`                 — never bootstrapped; anomaly checks must be skipped, not fired.
 *  - `bootstrapping`        — a run is in progress.
 *  - `warm`                 — baseline and reputation are seeded; checks are live.
 *  - `insufficient_history` — the adapter returned too few samples; checks stay off
 *                             until a later run succeeds.
 *  - `failed`               — the history fetch failed; safe to retry.
 */
export type BootstrapStatus = "cold" | "bootstrapping" | "warm" | "insufficient_history" | "failed";

export interface SourceBootstrapRecord {
  feedId: string;
  sourceId: string;
  adapter: string;
  status: BootstrapStatus;
  baseline: SourceBaseline | null;
  /** Seeded reputation in [0, SEED_REPUTATION_CAP]. */
  reputation: number | null;
  /** Fraction of expected samples present over the lookback window. */
  coverage: number | null;
  /** Agreement rate with peer sources, or null when there was nothing to compare. */
  corroboration: number | null;
  corroboratedBuckets: number;
  lookbackMs: number;
  expectedIntervalMs: number;
  error: string | null;
  requestedBy: string | null;
  updatedAt: string;
}

export interface BootstrapStore {
  getRecord(feedId: string, sourceId: string): Promise<SourceBootstrapRecord | null>;
  listRecords(feedId?: string): Promise<SourceBootstrapRecord[]>;
  saveRecord(record: SourceBootstrapRecord): Promise<void>;
  /** Replaces previously seeded history for the pair. Live readings are untouched. */
  replaceSeedReadings(feedId: string, sourceId: string, samples: HistoricalSample[]): Promise<void>;
  getSeedReadings(feedId: string, sourceId: string): Promise<HistoricalSample[]>;
}

const key = (feedId: string, sourceId: string): string => `${feedId}\u0000${sourceId}`;

/** Process-local store for sandbox mode and tests. */
export class InMemoryBootstrapStore implements BootstrapStore {
  private readonly records = new Map<string, SourceBootstrapRecord>();
  private readonly readings = new Map<string, HistoricalSample[]>();

  async getRecord(feedId: string, sourceId: string): Promise<SourceBootstrapRecord | null> {
    const record = this.records.get(key(feedId, sourceId));
    return record ? { ...record } : null;
  }

  async listRecords(feedId?: string): Promise<SourceBootstrapRecord[]> {
    return [...this.records.values()]
      .filter((record) => feedId === undefined || record.feedId === feedId)
      .map((record) => ({ ...record }));
  }

  async saveRecord(record: SourceBootstrapRecord): Promise<void> {
    this.records.set(key(record.feedId, record.sourceId), { ...record });
  }

  async replaceSeedReadings(feedId: string, sourceId: string, samples: HistoricalSample[]): Promise<void> {
    this.readings.set(key(feedId, sourceId), samples.map((sample) => ({ ...sample })));
  }

  async getSeedReadings(feedId: string, sourceId: string): Promise<HistoricalSample[]> {
    return (this.readings.get(key(feedId, sourceId)) ?? []).map((sample) => ({ ...sample }));
  }
}

/** Minimal query surface so the store works with a pg Pool, PoolClient, or DatabaseService. */
export interface SqlQueryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

interface RecordRow {
  feed_id: string;
  source_id: string;
  adapter: string;
  status: BootstrapStatus;
  baseline: SourceBaseline | null;
  reputation: string | number | null;
  coverage: string | number | null;
  corroboration: string | number | null;
  corroborated_buckets: number;
  lookback_ms: string | number;
  expected_interval_ms: string | number;
  error: string | null;
  requested_by: string | null;
  updated_at: Date | string;
}

const toNumberOrNull = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

function fromRow(row: RecordRow): SourceBootstrapRecord {
  return {
    feedId: row.feed_id,
    sourceId: row.source_id,
    adapter: row.adapter,
    status: row.status,
    baseline: row.baseline,
    reputation: toNumberOrNull(row.reputation),
    coverage: toNumberOrNull(row.coverage),
    corroboration: toNumberOrNull(row.corroboration),
    corroboratedBuckets: row.corroborated_buckets,
    lookbackMs: Number(row.lookback_ms),
    expectedIntervalMs: Number(row.expected_interval_ms),
    error: row.error,
    requestedBy: row.requested_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Postgres-backed store. Schema: src/db/migrations/004_oracle_source_bootstrap.sql.
 */
export class PgBootstrapStore implements BootstrapStore {
  constructor(private readonly db: SqlQueryable) {}

  async getRecord(feedId: string, sourceId: string): Promise<SourceBootstrapRecord | null> {
    const { rows } = await this.db.query<RecordRow>(
      `SELECT * FROM oracle_source_baselines WHERE feed_id = $1 AND source_id = $2`,
      [feedId, sourceId]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listRecords(feedId?: string): Promise<SourceBootstrapRecord[]> {
    const { rows } =
      feedId === undefined
        ? await this.db.query<RecordRow>(
            `SELECT * FROM oracle_source_baselines ORDER BY feed_id, source_id`
          )
        : await this.db.query<RecordRow>(
            `SELECT * FROM oracle_source_baselines WHERE feed_id = $1 ORDER BY source_id`,
            [feedId]
          );
    return rows.map(fromRow);
  }

  async saveRecord(record: SourceBootstrapRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO oracle_source_baselines (
         feed_id, source_id, adapter, status, baseline, reputation, coverage,
         corroboration, corroborated_buckets, lookback_ms, expected_interval_ms,
         error, requested_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (feed_id, source_id) DO UPDATE SET
         adapter = EXCLUDED.adapter,
         status = EXCLUDED.status,
         baseline = EXCLUDED.baseline,
         reputation = EXCLUDED.reputation,
         coverage = EXCLUDED.coverage,
         corroboration = EXCLUDED.corroboration,
         corroborated_buckets = EXCLUDED.corroborated_buckets,
         lookback_ms = EXCLUDED.lookback_ms,
         expected_interval_ms = EXCLUDED.expected_interval_ms,
         error = EXCLUDED.error,
         requested_by = EXCLUDED.requested_by,
         updated_at = EXCLUDED.updated_at`,
      [
        record.feedId,
        record.sourceId,
        record.adapter,
        record.status,
        record.baseline === null ? null : JSON.stringify(record.baseline),
        record.reputation,
        record.coverage,
        record.corroboration,
        record.corroboratedBuckets,
        record.lookbackMs,
        record.expectedIntervalMs,
        record.error,
        record.requestedBy,
        record.updatedAt,
      ]
    );
  }

  async replaceSeedReadings(feedId: string, sourceId: string, samples: HistoricalSample[]): Promise<void> {
    await this.db.query(`DELETE FROM oracle_seed_readings WHERE feed_id = $1 AND source_id = $2`, [
      feedId,
      sourceId,
    ]);
    // Insert in chunks to stay well under Postgres' 65535 bind-parameter limit.
    const CHUNK = 1_000;
    for (let offset = 0; offset < samples.length; offset += CHUNK) {
      const chunk = samples.slice(offset, offset + CHUNK);
      const params: unknown[] = [feedId, sourceId];
      const values = chunk.map((sample, index) => {
        params.push(new Date(sample.timestamp).toISOString(), sample.value);
        return `($1, $2, $${3 + index * 2}, $${4 + index * 2})`;
      });
      await this.db.query(
        `INSERT INTO oracle_seed_readings (feed_id, source_id, observed_at, value)
         VALUES ${values.join(", ")}
         ON CONFLICT (feed_id, source_id, observed_at) DO UPDATE SET value = EXCLUDED.value`,
        params
      );
    }
  }

  async getSeedReadings(feedId: string, sourceId: string): Promise<HistoricalSample[]> {
    const { rows } = await this.db.query<{ observed_at: Date | string; value: string | number }>(
      `SELECT observed_at, value FROM oracle_seed_readings
       WHERE feed_id = $1 AND source_id = $2 ORDER BY observed_at`,
      [feedId, sourceId]
    );
    return rows.map((row) => ({ timestamp: new Date(row.observed_at).getTime(), value: Number(row.value) }));
  }
}
