import { test } from "node:test";
import assert from "node:assert/strict";
import { E2EPublishSettlementHarness } from "./e2ePublishSettlementHarness.ts";

test("E2EPublishSettlementHarness exercises publish, single settlement, insufficient pool balance, and contract rejection", () => {
  const harness = new E2EPublishSettlementHarness(1_000n);

  harness.registerPolicy({
    policyId: "pol-1",
    coverageType: "DROUGHT_INDEX",
    triggerThreshold: 80,
    payoutAmountStroops: 600n,
    settled: false,
  });
  harness.registerPolicy({
    policyId: "pol-2",
    coverageType: "DROUGHT_INDEX",
    triggerThreshold: 80,
    payoutAmountStroops: 600n,
    settled: false,
  });

  // First run settles pol-1 (600 <= 1000) and fails pol-2 due to insufficient pool balance (400 < 600)
  const firstRun = harness.runFullPipeline({
    coverageType: "DROUGHT_INDEX",
    ingestedSourceValues: [85, 90, 88],
    minQuorum: 2,
  });
  assert.equal(firstRun.consensusReached, true);
  assert.deepEqual(firstRun.settledPolicyIds, ["pol-1"]);
  assert.deepEqual(firstRun.failedPolicyIds, ["pol-2"]);
  assert.equal(firstRun.poolEvents.length, 2);

  // Re-running does not double-settle pol-1
  const secondRun = harness.runFullPipeline({
    coverageType: "DROUGHT_INDEX",
    ingestedSourceValues: [85, 90, 88],
    minQuorum: 2,
  });
  assert.deepEqual(secondRun.settledPolicyIds, []);

  // Contract rejection path
  harness.setContractRejectMode(true);
  assert.throws(() =>
    harness.runFullPipeline({
      coverageType: "DROUGHT_INDEX",
      ingestedSourceValues: [85, 90],
      minQuorum: 2,
    })
  );
});
