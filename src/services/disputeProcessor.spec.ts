import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BondedDisputeProcessor } from "./disputeProcessor.ts";

describe("BondedDisputeProcessor (Issue #207)", () => {
  it("enforces challenge windows, bond minimums, duplicate guards, and pauses settlement while a dispute is active", () => {
    const processor = new BondedDisputeProcessor({
      challengeWindowMsByCoverage: { flight_delay: 60_000 },
      minDisputeBondAmount: 500n,
      authorizedChallengers: ["policyholder-1", "operator-2"],
    });

    const t0 = 1_700_000_000_000;
    processor.recordDecision({
      decisionId: "dec-101",
      coverageType: "flight_delay",
      claimId: "claim-101",
      agreedValue: 30,
      payoutTriggered: false,
      decidedAtMs: t0,
    });

    // Unauthorized caller or insufficient bond rejected
    assert.throws(() => {
      processor.openDispute({
        decisionId: "dec-101",
        challengerId: "anonymous-griefer",
        reason: "Invalid",
        bondReferenceId: "bond-1",
        bondAmount: 500n,
        nowMs: t0 + 5_000,
      });
    }, /UNAUTHORIZED_CHALLENGER/);

    assert.throws(() => {
      processor.openDispute({
        decisionId: "dec-101",
        challengerId: "policyholder-1",
        reason: "Too small bond",
        bondReferenceId: "bond-1",
        bondAmount: 100n,
        nowMs: t0 + 5_000,
      });
    }, /INSUFFICIENT_OR_MISSING_DISPUTE_BOND/);

    // Challenge after 60s window closes -> rejected
    assert.throws(() => {
      processor.openDispute({
        decisionId: "dec-101",
        challengerId: "policyholder-1",
        reason: "Too late",
        bondReferenceId: "bond-1",
        bondAmount: 500n,
        nowMs: t0 + 65_000,
      });
    }, /DECISION_CHALLENGE_WINDOW_CLOSED/);

    // Valid challenge within window
    const dispute = processor.openDispute({
      decisionId: "dec-101",
      challengerId: "policyholder-1",
      reason: "Official airline arrival log shows 185m delay",
      bondReferenceId: "bond-ref-99",
      bondAmount: 500n,
      nowMs: t0 + 10_000,
    });
    assert.equal(dispute.status, "open");
    assert.equal(processor.getOpenDisputeCount(), 1);

    // Duplicate challenge for same decision rejected
    assert.throws(() => {
      processor.openDispute({
        decisionId: "dec-101",
        challengerId: "operator-2",
        reason: "Duplicate",
        bondReferenceId: "bond-ref-100",
        bondAmount: 500n,
        nowMs: t0 + 12_000,
      });
    }, /DUPLICATE_ACTIVE_DISPUTE/);

    // Settlement is held while dispute is active
    const holdCheck = processor.trySettleClaimForDecision("dec-101");
    assert.equal(holdCheck.settled, false);
    assert.equal(holdCheck.reason, "ACTIVE_DISPUTE_HOLD");
  });

  it("reverses a disputed decision via a linked superseding decision without mutating original evidence or double-paying", () => {
    const processor = new BondedDisputeProcessor({
      challengeWindowMsByCoverage: { flight_delay: 60_000 },
      minDisputeBondAmount: 500n,
    });

    const t0 = 1_700_000_000_000;
    processor.recordDecision({
      decisionId: "dec-202",
      coverageType: "flight_delay",
      claimId: "claim-202",
      agreedValue: 20,
      payoutTriggered: false,
      decidedAtMs: t0,
    });

    const dispute = processor.openDispute({
      decisionId: "dec-202",
      challengerId: "policyholder-1",
      reason: "Missed corroborating source",
      bondReferenceId: "bond-202",
      bondAmount: 500n,
      nowMs: t0 + 5_000,
    });

    processor.beginReview(dispute.disputeId, t0 + 10_000);

    const resolution = processor.resolveDispute({
      disputeId: dispute.disputeId,
      outcome: "reversed",
      recomputedValue: 195,
      recomputedPayoutTriggered: true,
      nowMs: t0 + 20_000,
    });

    assert.equal(resolution.dispute.status, "reversed");
    assert.equal(resolution.dispute.bondDisposition, "refunded");
    assert.equal(resolution.compensatingPayoutExecuted, true);
    assert.equal(
      resolution.replacementDecision?.supersedesDecisionId,
      "dec-202"
    );

    // Original decision record remains strictly unmutated
    const orig = processor.getDecision("dec-202");
    assert.equal(orig?.agreedValue, 20);
    assert.equal(orig?.payoutTriggered, false);

    // Subsequent attempt to settle the replacement decision is blocked against double payout
    const secondSettle = processor.trySettleClaimForDecision(
      resolution.replacementDecision!.decisionId
    );
    assert.equal(secondSettle.settled, false);
    assert.equal(secondSettle.reason, "ALREADY_PAID");
    assert.equal(processor.getOpenDisputeCount(), 0);
  });
});
