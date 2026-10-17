import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TamperEvidentAuditLogger,
  type ChainedAuditRecord,
} from "./tamperEvidentAuditLogger.ts";

test("TamperEvidentAuditLogger chains hashes, redacts secrets, and buffers failed SIEM exports for retry", async () => {
  const exportedToSiem: ChainedAuditRecord[] = [];
  let siemOnline = false;

  const logger = new TamperEvidentAuditLogger({
    siemExporter: async (rec) => {
      if (!siemOnline) {
        throw new Error("SIEM syslog webhook unreachable");
      }
      exportedToSiem.push(rec);
    },
  });

  // 1. Admin pause while SIEM is offline -> persisted locally and queued in SIEM buffer
  const r1 = await logger.record({
    requestId: "req-1",
    actor: "alice@refract.finance",
    action: "FEED_PAUSE",
    targetId: "USDC-DEPEG",
    reason: "Primary provider maintenance",
    beforeState: { paused: false, apiKey: "super-secret-key" },
    afterState: { paused: true, apiKey: "super-secret-key" },
    timestampMs: 1_000,
  });
  assert.equal(r1.sequenceNumber, 1);
  assert.equal(r1.prevHash, "GENESIS");
  assert.equal(r1.beforeState.apiKey, "[REDACTED]");
  assert.equal(logger.getSiemMetrics().pendingCount, 1);

  // 2. Quorum policy edit + manual override when SIEM recovers
  siemOnline = true;
  const r2 = await logger.record({
    requestId: "req-2",
    actor: "bob@refract.finance",
    action: "QUORUM_POLICY_EDIT",
    targetId: "USDC-DEPEG",
    reason: "Increase corroboration minimum",
    beforeState: { minSources: 2 },
    afterState: { minSources: 3 },
    timestampMs: 2_000,
  });
  const r3 = await logger.record({
    requestId: "req-3",
    actor: "alice@refract.finance",
    action: "MANUAL_OVERRIDE",
    targetId: "USDC-DEPEG",
    reason: "Approved emergency override",
    beforeState: { value: 1.0 },
    afterState: { value: 0.97 },
    timestampMs: 3_000,
  });

  assert.equal(r2.prevHash, r1.entryHash);
  assert.equal(r3.prevHash, r2.entryHash);
  assert.deepEqual(logger.verifyHashChain(), {
    valid: true,
    brokenAtSequence: null,
  });

  // Flush buffered SIEM event from outage
  const flushRes = await logger.flushPendingSiemBuffer();
  assert.equal(flushRes.flushedCount, 1);
  assert.equal(flushRes.remainingCount, 0);
  assert.equal(exportedToSiem.length, 3);

  // Query by actor and time range
  const aliceRecords = logger.queryAuditHistory({
    actor: "alice@refract.finance",
    startMs: 1_500,
    endMs: 3_500,
  });
  assert.equal(aliceRecords.length, 1);
  assert.equal(aliceRecords[0].action, "MANUAL_OVERRIDE");
});
