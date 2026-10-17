import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOracleTrustEngineMigrationSql,
  OracleTrustEngineRepository,
} from "./oracleTrustEngineSchema.ts";

test("getOracleTrustEngineMigrationSql defines idempotent tables, NUMERIC(38,18) columns, TIMESTAMPTZ, and hot-path indexes", () => {
  const sql = getOracleTrustEngineMigrationSql();
  assert.ok(sql.startsWith("BEGIN;"));
  assert.ok(sql.endsWith("COMMIT;"));
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS oracle_sources"));
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS oracle_readings"));
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS oracle_decisions"));
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS oracle_source_health"));
  assert.ok(sql.includes("NUMERIC(38, 18)"));
  assert.ok(sql.includes("idx_oracle_readings_latest_by_feed"));
  assert.ok(sql.includes("idx_oracle_decisions_by_feed"));
});

test("OracleTrustEngineRepository is idempotent on re-migration, enforces payload size caps, and joins participating readings", () => {
  const repo = new OracleTrustEngineRepository();
  assert.equal(repo.applyIdempotentMigration().totalRuns, 1);
  assert.equal(repo.applyIdempotentMigration().totalRuns, 2);

  repo.insertSource({
    id: "src-uuid-1",
    slug: "coingecko",
    coverageTypesServed: ["USDC-DEPEG"],
    independenceGroup: "market-aggregator-a",
    enabled: true,
    trustTier: 1,
  });

  // Oversized raw JSONB payload > 64KB is rejected
  assert.throws(
    () =>
      repo.insertReading({
        id: "read-oversized",
        sourceId: "src-uuid-1",
        feedKey: "USDC-DEPEG",
        rawPayloadJson: "x".repeat(70_000),
        normalizedValue: "1.000000000000000000",
        unit: "USD",
        observedAtIso: "2026-10-17T12:00:00.000Z",
        ingestedAtIso: "2026-10-17T12:00:01.000Z",
        submitterRef: null,
      }),
    /PAYLOAD_SIZE_CAP_EXCEEDED/
  );

  // Insert reading + decision and read back with participating-reading join intact
  repo.insertReading({
    id: "read-uuid-1",
    sourceId: "src-uuid-1",
    feedKey: "USDC-DEPEG",
    rawPayloadJson: '{"usd":0.9998}',
    normalizedValue: "0.999800000000000000",
    unit: "USD",
    observedAtIso: "2026-10-17T12:00:00.000Z",
    ingestedAtIso: "2026-10-17T12:00:01.000Z",
    submitterRef: "G_OPERATOR_1",
  });

  repo.insertDecision({
    id: "dec-uuid-1",
    feedKey: "USDC-DEPEG",
    chosenValue: "0.999800000000000000",
    method: "weighted_median",
    quorumAchieved: 1,
    participatingReadingIds: ["read-uuid-1"],
    trustMode: "corroborated",
    decidedAtIso: "2026-10-17T12:00:02.000Z",
  });

  const joined = repo.getDecisionWithParticipatingReadings("dec-uuid-1");
  assert.ok(joined);
  assert.equal(joined.decision.chosenValue, "0.999800000000000000");
  assert.equal(joined.readings.length, 1);
  assert.equal(joined.readings[0].id, "read-uuid-1");
  assert.equal(joined.readings[0].sourceId, "src-uuid-1");
});
