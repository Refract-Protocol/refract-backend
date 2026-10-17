export const MAX_RAW_PAYLOAD_BYTES = 65_536;

export interface OracleSourceRow {
  id: string;
  slug: string;
  coverageTypesServed: string[];
  independenceGroup: string;
  enabled: boolean;
  trustTier: number;
}

export interface OracleReadingRow {
  id: string;
  sourceId: string;
  feedKey: string;
  rawPayloadJson: string;
  normalizedValue: string; // exact decimal string representing NUMERIC(38,18)
  unit: string;
  observedAtIso: string;
  ingestedAtIso: string;
  submitterRef: string | null;
}

export interface OracleDecisionRow {
  id: string;
  feedKey: string;
  chosenValue: string;
  method: "weighted_median" | "median" | "single";
  quorumAchieved: number;
  participatingReadingIds: string[];
  trustMode: "single" | "corroborated" | "decentralized";
  decidedAtIso: string;
}

export interface OracleSourceHealthRow {
  sourceId: string;
  rollingFailures: number;
  lastSuccessAtIso: string | null;
  quarantined: boolean;
}

/**
 * Returns the transactional, idempotent SQL migration for `002_oracle_trust_engine.sql`.
 */
export function getOracleTrustEngineMigrationSql(): string {
  return `BEGIN;

CREATE TABLE IF NOT EXISTS oracle_sources (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  coverage_types_served TEXT[] NOT NULL,
  independence_group TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  trust_tier INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oracle_readings (
  id UUID PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES oracle_sources(id),
  feed_key TEXT NOT NULL,
  raw_payload JSONB NOT NULL CHECK (octet_length(raw_payload::text) <= 65536),
  normalized_value NUMERIC(38, 18) NOT NULL,
  unit TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitter_ref TEXT
);

CREATE TABLE IF NOT EXISTS oracle_decisions (
  id UUID PRIMARY KEY,
  feed_key TEXT NOT NULL,
  chosen_value NUMERIC(38, 18) NOT NULL,
  method TEXT NOT NULL,
  quorum_achieved INTEGER NOT NULL,
  participating_reading_ids UUID[] NOT NULL,
  trust_mode TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oracle_source_health (
  source_id UUID PRIMARY KEY REFERENCES oracle_sources(id),
  rolling_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  quarantined BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oracle_readings_latest_by_feed
  ON oracle_readings (feed_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_oracle_readings_time_range
  ON oracle_readings (source_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_oracle_decisions_by_feed
  ON oracle_decisions (feed_key, decided_at DESC);

COMMIT;`;
}

export class OracleTrustEngineRepository {
  private migratedCount = 0;
  private readonly sources = new Map<string, OracleSourceRow>();
  private readonly readings = new Map<string, OracleReadingRow>();
  private readonly decisions = new Map<string, OracleDecisionRow>();
  private readonly health = new Map<string, OracleSourceHealthRow>();

  public applyIdempotentMigration(): { applied: boolean; totalRuns: number } {
    this.migratedCount += 1;
    return { applied: true, totalRuns: this.migratedCount };
  }

  public insertSource(source: OracleSourceRow): void {
    this.sources.set(source.id, { ...source });
  }

  public insertReading(reading: OracleReadingRow): void {
    if (!this.sources.has(reading.sourceId)) {
      throw new Error(`FOREIGN_KEY_VIOLATION: Unknown sourceId '${reading.sourceId}'`);
    }
    const byteLength = Buffer.byteLength(reading.rawPayloadJson, "utf8");
    if (byteLength > MAX_RAW_PAYLOAD_BYTES) {
      throw new Error(
        `PAYLOAD_SIZE_CAP_EXCEEDED: raw_payload (${byteLength} bytes) exceeds 65536-byte limit`
      );
    }
    this.readings.set(reading.id, { ...reading });
  }

  public insertDecision(decision: OracleDecisionRow): void {
    for (const rId of decision.participatingReadingIds) {
      if (!this.readings.has(rId)) {
        throw new Error(
          `MISSING_PARTICIPATING_READING: Reading '${rId}' does not exist`
        );
      }
    }
    this.decisions.set(decision.id, {
      ...decision,
      participatingReadingIds: [...decision.participatingReadingIds],
    });
  }

  public getDecisionWithParticipatingReadings(decisionId: string): {
    decision: OracleDecisionRow;
    readings: OracleReadingRow[];
  } | null {
    const decision = this.decisions.get(decisionId);
    if (!decision) return null;
    const readings = decision.participatingReadingIds
      .map((id) => this.readings.get(id))
      .filter((r): r is OracleReadingRow => r !== undefined);
    return { decision, readings };
  }
}
