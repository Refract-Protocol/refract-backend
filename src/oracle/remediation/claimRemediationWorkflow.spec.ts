import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaimRemediationWorkflow } from "./claimRemediationWorkflow.ts";

test("ClaimRemediationWorkflow enforces dual-control approval and state machine transitions", () => {
  const wf = new ClaimRemediationWorkflow();
  const rem = wf.proposeRemediation({
    originalClaimId: "claim-77",
    invalidatedDecisionId: "dec-bad-1",
    remedyType: "pay_difference",
    deltaAmountUsd: 5_000,
    requesterId: "alice@refract.finance",
    justification: "Retroactive re-evaluation confirmed deeper depeg",
  });

  // Cannot execute before approval
  assert.throws(
    () =>
      wf.executeRemediation({
        remediationId: rem.remediationId,
        executionTxRef: "0xtx",
      }),
    /INVALID_STATE_TRANSITION/
  );

  // Dual-control violation if requester tries to self-approve fund-moving remedy
  assert.throws(
    () =>
      wf.approveRemediation({
        remediationId: rem.remediationId,
        approverId: "alice@refract.finance",
      }),
    /DUAL_CONTROL_VIOLATION/
  );

  // Second operator approves -> executes -> closes
  const approved = wf.approveRemediation({
    remediationId: rem.remediationId,
    approverId: "bob@refract.finance",
  });
  assert.equal(approved.status, "approved");

  const executed = wf.executeRemediation({
    remediationId: rem.remediationId,
    executionTxRef: "0xpool-remedy-tx",
  });
  assert.equal(executed.status, "executed");

  const closed = wf.closeRemediation(rem.remediationId);
  assert.equal(closed.status, "closed");
  assert.equal(wf.listOpenRemediations().length, 0);
});
