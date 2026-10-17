import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OracleEvidenceWriteAheadSpool,
  type OracleEvidenceRecord,
} from "./evidenceWriteAheadSpool.ts";

describe("Oracle Evidence Write-Ahead Spooling (#230)", () => {
  it("spools records during PostgreSQL outage, quarantines torn tail records, and replays in causal stage + timestamp order", async () => {
    let postgresAvailable = false;
    const persistedRecords: OracleEvidenceRecord[] = [];
    const seenKeys = new Set<string>();

    const spool = new OracleEvidenceWriteAheadSpool({
      maxSpoolEntries: 10,
      persistToPostgres: async (record) => {
        if (!postgresAvailable) {
          throw new Error("ECONNREFUSED: PostgreSQL unavailable");
        }
        if (!seenKeys.has(record.idempotencyKey)) {
          seenKeys.add(record.idempotencyKey);
          persistedRecords.push(record);
        }
      },
    });

    // Write out-of-order stages during DB outage
    await spool.writeOrSpool(
      {
        idempotencyKey: "settle-1",
        stage: "settlement_outcome",
        feedId: "USDC/USD",
        observedAtMs: 1_700_000_003_000,
        payload: { payoutTriggered: true },
      },
      1_700_000_003_100
    );

    await spool.writeOrSpool(
      {
        idempotencyKey: "reading-1",
        stage: "evidence_reading",
        feedId: "USDC/USD",
        observedAtMs: 1_700_000_001_000,
        payload: { price: 0.94 },
      },
      1_700_000_001_100
    );

    await spool.writeOrSpool(
      {
        idempotencyKey: "consensus-1",
        stage: "consensus_decision",
        feedId: "USDC/USD",
        observedAtMs: 1_700_000_002_000,
        payload: { corroborated: true },
      },
      1_700_000_002_100
    );

    // Inject a torn/corrupted WAL tail line
    spool.appendRawWalLineForRecovery('{"sequenceNumber":99,"torn":true');

    const metricsBefore = spool.getMetrics(1_700_000_006_100);
    assert.equal(metricsBefore.spoolDepth, 4);
    assert.equal(metricsBefore.oldestEntryAgeMs, 5_000);

    // Restore Postgres and drain spool
    postgresAvailable = true;
    const drainResult = await spool.drainSpoolToPostgres();
    assert.equal(drainResult.replayedCount, 3);
    assert.equal(drainResult.quarantinedCount, 1);
    assert.equal(drainResult.remainingDepth, 0);

    // Causal order: evidence_reading -> consensus_decision -> settlement_outcome
    assert.deepEqual(
      persistedRecords.map((r) => r.idempotencyKey),
      ["reading-1", "consensus-1", "settle-1"]
    );
    // Original observation timestamps are preserved
    assert.deepEqual(
      persistedRecords.map((r) => r.observedAtMs),
      [1_700_000_001_000, 1_700_000_002_000, 1_700_000_003_000]
    );
  });

  it("raises explicit SPOOL_OVERFLOW_ALARM instead of silently truncating when backlog reaches capacity", async () => {
    const spool = new OracleEvidenceWriteAheadSpool({
      maxSpoolEntries: 2,
      persistToPostgres: async () => {
        throw new Error("DB down");
      },
    });

    await spool.writeOrSpool({
      idempotencyKey: "k1",
      stage: "evidence_reading",
      feedId: "XLM/USD",
      observedAtMs: 1000,
      payload: {},
    });
    await spool.writeOrSpool({
      idempotencyKey: "k2",
      stage: "evidence_reading",
      feedId: "XLM/USD",
      observedAtMs: 2000,
      payload: {},
    });

    await assert.rejects(
      () =>
        spool.writeOrSpool({
          idempotencyKey: "k3",
          stage: "evidence_reading",
          feedId: "XLM/USD",
          observedAtMs: 3000,
          payload: {},
        }),
      /SPOOL_OVERFLOW_ALARM/
    );
    assert.equal(spool.getMetrics().overflowAlarmActive, true);
  });
});
