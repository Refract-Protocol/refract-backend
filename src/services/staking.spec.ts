import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OperatorStakingService } from "./staking.ts";

describe("OperatorStakingService (Issue #192)", () => {
  const baseConfig = {
    minBondByTier: {
      tier_standard: 1_000n,
      tier_high_value: 5_000n,
      tier_critical: 10_000n,
    },
    minBondAgeMs: 60_000,
    unbondingPeriodMs: 300_000,
    requiredSlashApprovals: 2,
    authorizedApprovers: ["admin-1", "admin-2", "admin-3"],
  };

  it("enforces minimum bond and minimum bond age before allowing an operator into feed quorum", () => {
    const staking = new OperatorStakingService(baseConfig);
    const t0 = 1_700_000_000_000;

    staking.bond("op-alpha", 5_000n, t0);

    // Flash-bond check: bond age is 10s (< 60s minBondAgeMs) -> rejected
    const tooYoung = staking.isEligibleForFeedQuorum(
      "op-alpha",
      "tier_standard",
      t0 + 10_000
    );
    assert.equal(tooYoung.eligible, false);
    assert.equal(tooYoung.reason, "BOND_AGE_TOO_YOUNG");

    // After 65s, eligible for standard and high_value, but insufficient for critical (10,000n)
    const eligibleHigh = staking.isEligibleForFeedQuorum(
      "op-alpha",
      "tier_high_value",
      t0 + 65_000
    );
    assert.equal(eligibleHigh.eligible, true);

    const insufficientCritical = staking.isEligibleForFeedQuorum(
      "op-alpha",
      "tier_critical",
      t0 + 65_000
    );
    assert.equal(insufficientCritical.eligible, false);
    assert.equal(insufficientCritical.reason, "INSUFFICIENT_BOND_FOR_TIER");
  });

  it("executes idempotent multisig slashing proposals and blocks unbond withdrawal while proposals are pending", () => {
    const staking = new OperatorStakingService(baseConfig);
    const t0 = 1_700_000_000_000;

    staking.bond("op-bravo", 10_000n, t0);
    const unbondReq = staking.requestUnbond("op-bravo", 4_000n, t0 + 70_000);
    assert.equal(unbondReq.amount, 4_000n);

    // Faulty equivocating submission detected with evidenceId ev-901 (50% slash of 10,000n total pool = 5,000n)
    const prop1 = staking.proposeSlash({
      operatorId: "op-bravo",
      evidenceId: "ev-901",
      reason: "equivocation_double_submission",
      nowMs: t0 + 80_000,
    });
    // Replayed proposal for same evidenceId returns identical proposal idempotently
    const propDuplicate = staking.proposeSlash({
      operatorId: "op-bravo",
      evidenceId: "ev-901",
      reason: "equivocation_double_submission",
      nowMs: t0 + 81_000,
    });
    assert.equal(prop1.proposalId, propDuplicate.proposalId);
    assert.equal(prop1.proposedSlashAmount, 5_000n);

    // Even after unbonding timer expires, withdrawal is blocked while slashing proposal is pending
    assert.throws(() => {
      staking.withdrawUnbonded(
        "op-bravo",
        unbondReq.requestId,
        t0 + 400_000
      );
    }, /slashing proposal\(s\) are pending/);

    // 1st approval does not execute yet (requires 2 approvals)
    const afterFirstApproval = staking.approveAndExecuteSlash(
      prop1.proposalId,
      "admin-1",
      t0 + 90_000
    );
    assert.equal(afterFirstApproval.status, "pending");

    // 2nd approval executes the 5,000n slash (activeBondedAmount goes from 6,000n -> 1,000n)
    const executed = staking.approveAndExecuteSlash(
      prop1.proposalId,
      "admin-2",
      t0 + 95_000
    );
    assert.equal(executed.status, "executed");
    assert.equal(executed.executedSlashAmount, 5_000n);

    const statusView = staking.getOperatorStakeStatus("op-bravo", t0 + 400_000);
    assert.equal(statusView.activeBondedAmount, 1_000n);
    assert.equal(statusView.totalSlashedAmount, 5_000n);
    assert.equal(statusView.pendingSlashingProposals.length, 0);

    // Now that no pending slashing proposals remain and unbonding period elapsed, withdrawal succeeds
    const withdrawal = staking.withdrawUnbonded(
      "op-bravo",
      unbondReq.requestId,
      t0 + 400_000
    );
    assert.equal(withdrawal.withdrawnAmount, 4_000n);
  });
});
