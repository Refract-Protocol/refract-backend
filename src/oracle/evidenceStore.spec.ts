import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AppendOnlyEvidenceStore,
  buildOracleEvidenceMigrationSql,
} from "./evidenceStore.ts";

describe("AppendOnlyEvidenceStore (Issue #176)", () => {
  it("links source readings -> decision -> settlement txHash, scrubs secrets, and caps oversized raw payloads", () => {
    const store = new AppendOnlyEvidenceStore({ maxRawPayloadBytes: 120 });
    const t0 = 1_700_000_000_000;

    const r1 = store.appendReading({
      sourceId: "coingecko",
      coverageType: "stablecoin_depeg",
      rawPayload: JSON.stringify({
        api_key: "super-secret-key-123",
        usdc_usd: 0.94,
      }),
      normalizedValue: 0.94,
      observedAtMs: t0 - 2_000,
      ingestedAtMs: t0,
    });

    const r2 = store.appendReading({
      sourceId: "defillama",
      coverageType: "stablecoin_depeg",
      rawPayload: "x".repeat(300),
      normalizedValue: 0.942,
      observedAtMs: t0 - 1_500,
      ingestedAtMs: t0,
    });

    assert.equal(r1.rawPayloadTruncated.includes("super-secret-key-123"), false);
    assert.equal(r1.rawPayloadTruncated.includes("[REDACTED]"), true);
    assert.equal(r2.payloadWasTruncated, true);

    // Decision is recorded BEFORE settlement submission
    const decision = store.recordDecisionBeforeSettlement({
      coverageType: "stablecoin_depeg",
      contributingReadingIds: [r1.readingId, r2.readingId],
      chosenValue: 0.941,
      ruleApplied: "median_quorum_2_of_2",
      claimId: "claim-777",
      createdAtMs: t0 + 500,
    });
    assert.equal(decision.settlementStatus, "pending_settlement");

    // Backfill settlement transaction hash once on-chain transaction completes
    const settled = store.backfillSettlementOutcome({
      decisionId: decision.decisionId,
      settlementStatus: "settled_on_chain",
      settlementTxHash: "soroban-tx-abc123",
      settledAtMs: t0 + 2_000,
    });
    assert.equal(settled.settlementStatus, "settled_on_chain");
    assert.equal(settled.settlementTxHash, "soroban-tx-abc123");

    const auditChain = store.getAuditChainForDecision(decision.decisionId);
    assert.equal(auditChain.readings.length, 2);
    assert.equal(auditChain.decision.claimId, "claim-777");
  });

  it("enforces append-only immutability on evidence rows and finalized decision settlements", () => {
    const store = new AppendOnlyEvidenceStore();
    const r1 = store.appendReading({
      sourceId: "horizon",
      coverageType: "stablecoin_depeg",
      rawPayload: '{"price":0.95}',
      normalizedValue: 0.95,
      observedAtMs: 1_000,
    });

    assert.throws(() => {
      store.attemptMutateOrDeleteEvidence(r1.readingId);
    }, /APPEND_ONLY_VIOLATION/);

    const decision = store.recordDecisionBeforeSettlement({
      coverageType: "stablecoin_depeg",
      contributingReadingIds: [r1.readingId],
      chosenValue: 0.95,
      ruleApplied: "median",
      claimId: "claim-888",
    });

    store.backfillSettlementOutcome({
      decisionId: decision.decisionId,
      settlementStatus: "settled_on_chain",
      settlementTxHash: "tx-first",
    });

    // Attempting to overwrite an already finalized settlement outcome throws APPEND_ONLY_VIOLATION
    assert.throws(() => {
      store.backfillSettlementOutcome({
        decisionId: decision.decisionId,
        settlementStatus: "settled_on_chain",
        settlementTxHash: "tx-overwrite",
      });
    }, /APPEND_ONLY_VIOLATION/);

    const sql = buildOracleEvidenceMigrationSql();
    assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS oracle_evidence"));
    assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS oracle_decisions"));
  });
});
