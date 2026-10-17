import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OracleIngestionDeadLetterQueue } from "./ingestionDeadLetterQueue.ts";

describe("Dead-Letter Queue and Backfill Tooling for Failed Oracle Ingestions (#200)", () => {
  it("persists failed ingestions, replays them idempotently with dlq_replay provenance, and prevents overwriting existing windows", () => {
    const dlq = new OracleIngestionDeadLetterQueue({
      parseRawPayload: (raw) => {
        try {
          const parsed = JSON.parse(raw) as { price?: number };
          return typeof parsed.price === "number" && parsed.price > 0
            ? parsed.price
            : null;
        } catch {
          return null;
        }
      },
    });

    // Live reading at t=1000
    dlq.recordLiveReading({
      sourceId: "pyth",
      feedId: "USDC/USD",
      observationWindowStartMs: 1_000,
      canonicalValue: 1.0001,
    });

    // Failed ingestion at t=2000 (e.g. DB persistence transient failure)
    const entry = dlq.enqueueFailedIngestion({
      sourceId: "pyth",
      feedId: "USDC/USD",
      observationWindowStartMs: 2_000,
      observationWindowEndMs: 2_999,
      errorClass: "PERSISTENCE_ERROR",
      errorMessage: "DB timeout",
      rawPayload: JSON.stringify({ price: 0.9997 }),
    });

    assert.equal(dlq.getMetrics().pendingDlqDepth, 1);

    // Replay succeeds and marks provenance as dlq_replay
    const replay1 = dlq.replayDeadLetter(entry.dlqId, 5_000);
    assert.equal(replay1.replayed, true);
    assert.equal(replay1.reason, "REPLAYED_OK");
    assert.equal(replay1.reading?.provenance, "dlq_replay");
    assert.equal(replay1.reading?.canonicalValue, 0.9997);
    assert.equal(dlq.getMetrics().pendingDlqDepth, 0);

    // Second replay of the same dlqId is idempotent
    const replay2 = dlq.replayDeadLetter(entry.dlqId, 6_000);
    assert.equal(replay2.replayed, true);
    assert.equal(replay2.reason, "ALREADY_REPLAYED_IDEMPOTENT");

    // Backfill across [1000, 2000, 3000] skips occupied windows 1000 & 2000 and fills gap 3000
    const backfillRes = dlq.backfillHistoricalWindow({
      sourceId: "pyth",
      feedId: "USDC/USD",
      historicalPoints: [
        {
          observationWindowStartMs: 1_000,
          rawPayload: JSON.stringify({ price: 0.5 }), // must NOT overwrite existing 1.0001
        },
        {
          observationWindowStartMs: 2_000,
          rawPayload: JSON.stringify({ price: 0.5 }),
        },
        {
          observationWindowStartMs: 3_000,
          rawPayload: JSON.stringify({ price: 0.9999 }),
        },
      ],
    });

    assert.equal(backfillRes.insertedCount, 1);
    assert.equal(backfillRes.skippedExistingCount, 2);
  });
});
