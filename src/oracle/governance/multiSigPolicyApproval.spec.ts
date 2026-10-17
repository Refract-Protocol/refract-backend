import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MultiSigOraclePolicyWorkflow } from "./multiSigPolicyApproval.ts";

describe("Multi-Sig Approval Workflow for Oracle Quorum Policy and Admin Changes (#220)", () => {
  it("fails closed when approver set is misconfigured and blocks self-approval or duplicate approvals", () => {
    assert.throws(
      () =>
        new MultiSigOraclePolicyWorkflow({
          approverAllowlist: ["admin-1", "admin-2"],
          requiredApprovals: 2, // needs at least 3 distinct admins (1 proposer + 2 approvers)
          applyPolicyDiff: () => {},
        }),
      /MISCONFIGURED_APPROVER_SET/
    );

    const appliedDiffs: Array<{
      coverageType: string;
      diff: Record<string, unknown>;
    }> = [];
    const workflow = new MultiSigOraclePolicyWorkflow({
      approverAllowlist: ["alice", "bob", "carol"],
      requiredApprovals: 2,
      applyPolicyDiff: (coverageType, diff) => {
        appliedDiffs.push({ coverageType, diff });
      },
    });

    const nowMs = 1_700_000_000_000;
    const prop = workflow.proposeChange({
      proposerId: "alice",
      coverageType: "stablecoin-depeg",
      rationale: "Raise quorum threshold to 3 sources",
      proposedDiff: { minDistinctSources: 3 },
      affectsPayoutTrigger: true,
      timelockDelayMs: 10_000,
      ttlMs: 60_000,
      nowMs,
    });

    // Self-approval by proposer is rejected
    assert.throws(
      () =>
        workflow.approveProposal({
          proposalId: prop.proposalId,
          approverId: "alice",
          nowMs: nowMs + 1_000,
        }),
      /SELF_APPROVAL_FORBIDDEN/
    );

    // First approval by bob
    workflow.approveProposal({
      proposalId: prop.proposalId,
      approverId: "bob",
      nowMs: nowMs + 1_000,
    });

    // Duplicate approval by bob is rejected
    assert.throws(
      () =>
        workflow.approveProposal({
          proposalId: prop.proposalId,
          approverId: "bob",
          nowMs: nowMs + 2_000,
        }),
      /DUPLICATE_APPROVAL_FORBIDDEN/
    );

    // Premature execution with only 1/2 approvals fails
    assert.throws(
      () =>
        workflow.executeProposal({
          proposalId: prop.proposalId,
          executorId: "bob",
          nowMs: nowMs + 15_000,
        }),
      /INSUFFICIENT_APPROVALS/
    );

    // Second approval by carol reaches 2/2 quorum
    workflow.approveProposal({
      proposalId: prop.proposalId,
      approverId: "carol",
      nowMs: nowMs + 3_000,
    });

    // Execution before timelock (nowMs + 10_000) is blocked
    assert.throws(
      () =>
        workflow.executeProposal({
          proposalId: prop.proposalId,
          executorId: "carol",
          nowMs: nowMs + 5_000,
        }),
      /TIMELOCK_NOT_ELAPSED/
    );

    // Execution after timelock succeeds and applies diff
    const executed = workflow.executeProposal({
      proposalId: prop.proposalId,
      executorId: "carol",
      nowMs: nowMs + 12_000,
    });
    assert.equal(executed.status, "executed");
    assert.equal(appliedDiffs.length, 1);
    assert.deepEqual(appliedDiffs[0]?.diff, { minDistinctSources: 3 });
  });

  it("allows emergency pause fast-path without multi-sig deadlock and sweeps expired proposals", () => {
    const appliedDiffs: Array<{
      coverageType: string;
      diff: Record<string, unknown>;
    }> = [];
    const workflow = new MultiSigOraclePolicyWorkflow({
      approverAllowlist: ["alice", "bob", "carol"],
      requiredApprovals: 2,
      applyPolicyDiff: (coverageType, diff) => {
        appliedDiffs.push({ coverageType, diff });
      },
    });

    const nowMs = 1_700_000_000_000;
    const prop = workflow.proposeChange({
      proposerId: "alice",
      coverageType: "flight-delay",
      rationale: "Routine weight tweak",
      proposedDiff: { quorumThresholdWeight: 80 },
      affectsPayoutTrigger: false,
      ttlMs: 30_000,
      nowMs,
    });

    // Emergency pause bypasses quorum delay immediately and logs EMERGENCY_PAUSE_FAST_PATH
    workflow.executeEmergencyPauseFastPath({
      actorId: "bob",
      coverageType: "protocol-exploit",
      incidentReason: "Upstream RPC compromise suspected",
      nowMs: nowMs + 1_000,
    });
    assert.equal(appliedDiffs.length, 1);
    assert.equal(appliedDiffs[0]?.coverageType, "protocol-exploit");
    assert.equal(appliedDiffs[0]?.diff.emergencyPaused, true);

    // Sweep expired proposals after TTL
    const swept = workflow.sweepExpiredProposals(nowMs + 45_000);
    assert.deepEqual(swept, [prop.proposalId]);
    assert.ok(
      workflow
        .getAuditLog()
        .some((e) => e.eventType === "EMERGENCY_PAUSE_FAST_PATH")
    );
  });
});
