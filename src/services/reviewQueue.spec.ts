import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HumanReviewQueueService,
  type ReviewDecisionInput,
} from "./reviewQueue.ts";

function buildHighValueInput(overrides: Partial<ReviewDecisionInput> = {}): ReviewDecisionInput {
  return {
    claimId: "claim_9001",
    decisionId: "dec_9001",
    feedId: "LiquidationShield",
    payoutAmountStroops: 250_000_000_000n, // 25,000 units (> 10,000 threshold)
    confidenceScoreBps: 6_800, // < 7500 floor
    isEvidenceMature: true,
    contributingReadings: [
      { sourceId: "defillama", readingId: "r_1", reportedValueBps: 7_500, observedAtMs: 1_750_000_000_000 },
      { sourceId: "coingecko", readingId: "r_2", reportedValueBps: 7_450, observedAtMs: 1_750_000_000_000 },
    ],
    anomalyFlags: ["high_payout_tail"],
    createdAtMs: 1_750_000_000_000,
    ...overrides,
  };
}

test("Issue #282: holds high-value and low-confidence decisions, deduplicates retries, and never auto-approves on SLA timeout", () => {
  const queue = new HumanReviewQueueService({
    highValueThresholdStroops: 100_000_000_000n,
    minConfidenceFloorBps: 7_500,
    reviewSlaWindowMs: 60_000,
  });

  // Routine small high-confidence decision passes straight through
  const routine = queue.evaluateAndGateSettlement(
    buildHighValueInput({
      claimId: "claim_routine",
      decisionId: "dec_routine",
      payoutAmountStroops: 10_000_000_000n,
      confidenceScoreBps: 9_500,
    })
  );
  assert.equal(routine.requiresHumanReview, false);
  assert.equal(routine.canSettle, true);

  // High-value + low-confidence decision is held
  const held1 = queue.evaluateAndGateSettlement(buildHighValueInput());
  assert.equal(held1.requiresHumanReview, true);
  assert.equal(held1.canSettle, false);
  assert.ok(held1.reviewItemId);

  // Duplicate delivery returns same reviewItemId
  const held2 = queue.evaluateAndGateSettlement(buildHighValueInput());
  assert.equal(held2.reviewItemId, held1.reviewItemId);
  assert.equal(queue.getQueueMetrics().pendingCount, 1);

  // Advance clock past SLA deadline (60s): escalates, NEVER auto-approves
  const escalated = queue.checkSlaExpirations(1_750_000_000_000 + 61_000);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].status, "escalated");

  const afterTimeoutGate = queue.evaluateAndGateSettlement(buildHighValueInput());
  assert.equal(afterTimeoutGate.canSettle, false);
});

test("Issue #282: enforces RBAC on approve/reject, blocks approval of invalidated evidence, and allows settlement only after valid approval", () => {
  const queue = new HumanReviewQueueService();
  const now = 1_750_000_000_000;
  const held = queue.evaluateAndGateSettlement(buildHighValueInput());
  const itemId = held.reviewItemId!;

  // Unauthorized role ('operator' or 'viewer') cannot approve or reject
  assert.throws(
    () => queue.approve(itemId, "user_op", "operator", "looks fine", now + 1_000),
    /not authorized/
  );

  // Authorized role ('risk_officer') approves -> settlement gate opens with approvalReferenceId
  const approvedItem = queue.approve(
    itemId,
    "officer_alice",
    "risk_officer",
    "Verified against independent liquidation feed",
    now + 2_000
  );
  assert.equal(approvedItem.status, "approved");
  assert.ok(approvedItem.approvalReferenceId);

  const settledGate = queue.evaluateAndGateSettlement(buildHighValueInput());
  assert.equal(settledGate.canSettle, true);
  assert.equal(settledGate.approvalReferenceId, approvedItem.approvalReferenceId);

  // If underlying evidence is later invalidated, settlement is immediately revoked and re-approval is blocked
  queue.markEvidenceInvalidated(itemId, "Provider key revoked", now + 3_000);
  const revokedGate = queue.evaluateAndGateSettlement(buildHighValueInput());
  assert.equal(revokedGate.canSettle, false);

  assert.throws(
    () => queue.approve(itemId, "admin_bob", "oracle_admin", "force approve", now + 4_000),
    /invalidated/
  );
});
