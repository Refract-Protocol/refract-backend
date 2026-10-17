import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RetroactiveClaimReevaluator } from "./retroactiveClaimReevaluator.ts";

describe("RetroactiveClaimReevaluator (Issue #232)", () => {
  it("computes dry-run re-evaluation plans, settles held claims idempotently, and requires explicit operator approval before reversing settled claims", () => {
    const reevaluator = new RetroactiveClaimReevaluator();
    const t0 = 1_700_000_000_000;

    // 1. Held claim during degraded window whose policy was active at incident time (even if expired by re-evaluation time)
    reevaluator.registerClaim({
      claimId: "claim-a-held",
      policyId: "pol-a",
      coverageType: "stablecoin_depeg",
      payoutAmountUsd: 5_000,
      policyStartMs: t0 - 100_000,
      policyEndMs: t0 + 50_000,
      incidentTimestampMs: t0 + 10_000,
      evaluatedAtMs: t0 + 12_000,
      evaluatedTrustState: "degraded_held",
      originalDecisionId: "dec-degraded-1",
      status: "held_pending_trust",
      payoutTriggerPredicate: (val) => val <= 0.94,
    });

    // 2. Claim settled under degraded single-source spike (0.89), whereas restored corroborated consensus was 0.93 (threshold <= 0.90)
    reevaluator.registerClaim({
      claimId: "claim-b-settled-wrongly",
      policyId: "pol-b",
      coverageType: "stablecoin_depeg",
      payoutAmountUsd: 8_000,
      policyStartMs: t0 - 100_000,
      policyEndMs: t0 + 50_000,
      incidentTimestampMs: t0 + 15_000,
      evaluatedAtMs: t0 + 16_000,
      evaluatedTrustState: "degraded_settled",
      originalDecisionId: "dec-degraded-1",
      status: "settled",
      payoutTriggerPredicate: (val) => val <= 0.9,
    });

    reevaluator.registerRestoredDecision({
      decisionId: "dec-restored-good",
      coverageType: "stablecoin_depeg",
      windowStartMs: t0,
      windowEndMs: t0 + 30_000,
      agreedValue: 0.93,
      isValidCorroborated: true,
    });

    const plan = reevaluator.computeReevaluationDiff({
      coverageType: "stablecoin_depeg",
      degradedIntervalStartMs: t0,
      degradedIntervalEndMs: t0 + 30_000,
      restoredDecisionId: "dec-restored-good",
      nowMs: t0 + 200_000,
    });

    assert.equal(plan.items.length, 2);
    assert.equal(plan.items[0]?.proposedAction, "settle_held_claim");
    assert.equal(
      plan.items[1]?.proposedAction,
      "propose_reversal_of_settled_claim"
    );
    assert.equal(plan.items[1]?.requiresOperatorApproval, true);

    // Apply WITHOUT operatorApprovalId -> settles claim-a-held, but does NOT auto-reverse claim-b-settled-wrongly
    const applyWithoutApproval = reevaluator.applyReevaluationPlan({
      planId: plan.planId,
    });
    assert.deepEqual(applyWithoutApproval.settledClaimIds, ["claim-a-held"]);
    assert.deepEqual(applyWithoutApproval.reversedClaimIds, []);
    assert.deepEqual(applyWithoutApproval.skippedUnapprovedReversalIds, [
      "claim-b-settled-wrongly",
    ]);
    assert.equal(reevaluator.getClaim("claim-a-held")?.status, "settled");
    assert.equal(
      reevaluator.getClaim("claim-b-settled-wrongly")?.status,
      "settled"
    );

    // Re-applying with operatorApprovalId -> claim-a-held is NOT double-settled (idempotent), and claim-b is reversed
    const applyWithApproval = reevaluator.applyReevaluationPlan({
      planId: plan.planId,
      operatorApprovalId: "approval-admin-77",
    });
    assert.deepEqual(applyWithApproval.settledClaimIds, []);
    assert.deepEqual(applyWithApproval.reversedClaimIds, [
      "claim-b-settled-wrongly",
    ]);
    assert.equal(
      reevaluator.getClaim("claim-b-settled-wrongly")?.status,
      "reversed_after_review"
    );
    assert.equal(
      reevaluator.getClaim("claim-b-settled-wrongly")?.reversedByApprovalId,
      "approval-admin-77"
    );
  });

  it("supports batch pagination and skips re-evaluation when target decision is still invalid", () => {
    const reevaluator = new RetroactiveClaimReevaluator();
    const t0 = 1_700_000_000_000;

    for (let i = 1; i <= 3; i++) {
      reevaluator.registerClaim({
        claimId: `claim-${i}`,
        policyId: `pol-${i}`,
        coverageType: "flight_delay",
        payoutAmountUsd: 1_000,
        policyStartMs: t0,
        policyEndMs: t0 + 100_000,
        incidentTimestampMs: t0 + 10_000,
        evaluatedAtMs: t0 + 11_000,
        evaluatedTrustState: "degraded_held",
        originalDecisionId: "dec-bad",
        status: "held_pending_trust",
        payoutTriggerPredicate: (v) => v >= 120,
      });
    }

    const page1 = reevaluator.computeReevaluationDiff({
      coverageType: "flight_delay",
      degradedIntervalStartMs: t0,
      degradedIntervalEndMs: t0 + 50_000,
      restoredDecisionId: "non-existent-decision",
      cursorOffset: 0,
      maxBatchSize: 2,
    });

    assert.equal(page1.items.length, 2);
    assert.equal(page1.hasMorePages, true);
    assert.equal(page1.nextCursorOffset, 2);
    assert.equal(
      page1.items[0]?.proposedAction,
      "skip_decision_still_invalid"
    );
  });
});
