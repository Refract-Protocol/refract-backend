import { test } from "node:test";
import assert from "node:assert/strict";
import { IncompleteEvidencePayoutHoldManager } from "./incompleteEvidencePayoutHold.ts";

test("IncompleteEvidencePayoutHoldManager holds incomplete evidence, auto-releases on completion, and escalates on timeout", () => {
  const manager = new IncompleteEvidencePayoutHoldManager(60_000);

  const held = manager.evaluateDecision({
    decisionId: "dec-hold-1",
    requiredIndependentSources: 2,
    actualIndependentSources: 2,
    evaluatedAtMs: 1_000,
    evidenceItems: [
      { sourceId: "s1", hasRawPayload: true, isWarmingUp: false, signatureVerified: true },
      { sourceId: "s2", hasRawPayload: false, isWarmingUp: true, signatureVerified: false },
    ],
  });
  assert.equal(held.status, "payout_held");
  assert.deepEqual(held.holdReasons.sort(), [
    "missing_raw_payload",
    "unverified_provider_signature",
    "warming_up_source_included",
  ]);

  const released = manager.evaluateDecision({
    decisionId: "dec-hold-1",
    requiredIndependentSources: 2,
    actualIndependentSources: 2,
    evaluatedAtMs: 25_000,
    evidenceItems: [
      { sourceId: "s1", hasRawPayload: true, isWarmingUp: false, signatureVerified: true },
      { sourceId: "s2", hasRawPayload: true, isWarmingUp: false, signatureVerified: true },
    ],
  });
  assert.equal(released.status, "ready_for_settlement");
  assert.equal(released.releasedAtMs, 25_000);

  manager.evaluateDecision({
    decisionId: "dec-hold-2",
    requiredIndependentSources: 3,
    actualIndependentSources: 2,
    evaluatedAtMs: 10_000,
    evidenceItems: [],
  });
  const escalated = manager.evaluateDecision({
    decisionId: "dec-hold-2",
    requiredIndependentSources: 3,
    actualIndependentSources: 2,
    evaluatedAtMs: 80_000,
    evidenceItems: [],
  });
  assert.equal(escalated.status, "escalated_for_review");
});
