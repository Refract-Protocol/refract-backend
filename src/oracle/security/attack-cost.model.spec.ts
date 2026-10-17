import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOracleAttackCost,
  validateFeedExposureAgainstAttackCost,
  STROOPS_PER_UNIT,
  type OracleFeedSecurityInput,
} from "./attack-cost.model.ts";
import {
  generateSensitivityRows,
  renderSensitivityMarkdown,
} from "../../../scripts/model-oracle-attack-cost.ts";

function buildBaseFeedInput(): OracleFeedSecurityInput {
  return {
    feedId: "liquidation_shield_eth",
    sources: [1, 2, 3, 4, 5].map((i) => ({
      sourceId: `src_${i}`,
      weight: 1,
      briberyCostStroops: 100_000n * STROOPS_PER_UNIT,
      independenceGroup: `vendor_${i}`,
    })),
    sourceQuorumCount: 3,
    operatorCount: 5,
    operatorQuorumCount: 3,
    operatorBondStroops: 60_000n * STROOPS_PER_UNIT,
    keyCompromiseFloorStroops: 20_000n * STROOPS_PER_UNIT,
    configuredMaxExposureStroops: 110_000n * STROOPS_PER_UNIT,
    safetyFactorBps: 20_000, // 2.0x
  };
}

test("Issue #288: attack-cost model computes exact BigInt vector costs and satisfies monotonicity", () => {
  const base = buildBaseFeedInput();
  const baseResult = evaluateOracleAttackCost(base);

  // Source bribery: 3 * 100k = 300k; Operator compromise: 3 * (60k + 20k) = 240k -> limiting vector is operator_key_compromise
  assert.equal(baseResult.vectors.sourceBriberyCostStroops, 300_000n * STROOPS_PER_UNIT);
  assert.equal(baseResult.vectors.operatorKeyCompromiseCostStroops, 240_000n * STROOPS_PER_UNIT);
  assert.equal(baseResult.minAttackCostStroops, 240_000n * STROOPS_PER_UNIT);
  assert.equal(baseResult.limitingVector, "operator_key_compromise");
  // Max exposure at 2.0x safety factor = 120k >= configured 110k
  assert.equal(baseResult.maxSupportedExposureStroops, 120_000n * STROOPS_PER_UNIT);
  assert.equal(baseResult.isExposureSafe, true);

  // Monotonicity wrt operator bond
  const higherBond = evaluateOracleAttackCost({
    ...base,
    operatorBondStroops: 90_000n * STROOPS_PER_UNIT,
  });
  assert.equal(higherBond.minAttackCostStroops >= baseResult.minAttackCostStroops, true);

  // Monotonicity wrt quorum size
  const higherQuorum = evaluateOracleAttackCost({
    ...base,
    sourceQuorumCount: 4,
    operatorQuorumCount: 4,
  });
  assert.equal(higherQuorum.minAttackCostStroops > baseResult.minAttackCostStroops, true);
});

test("Issue #288: sources with unknown independenceGroup collapse into worst-case shared upstream group", () => {
  const base = buildBaseFeedInput();
  const unknownIndependenceInput: OracleFeedSecurityInput = {
    ...base,
    sources: base.sources.map((s, idx) => ({
      ...s,
      // First 3 sources omit independenceGroup -> treated as a single shared upstream
      independenceGroup: idx < 3 ? undefined : s.independenceGroup,
    })),
  };

  const result = evaluateOracleAttackCost(unknownIndependenceInput);
  assert.equal(result.vectors.sourceCollusionCostStroops, 100_000n * STROOPS_PER_UNIT);
  assert.equal(result.vectors.effectiveIndependentGroupsRequired, 1);
  assert.equal(result.limitingVector, "source_collusion");
  assert.equal(result.minAttackCostStroops, 100_000n * STROOPS_PER_UNIT);
  assert.equal(result.isExposureSafe, false);
});

test("Issue #288: startup validator fails closed when configured exposure exceeds max supported exposure", () => {
  const unsafeFeed: OracleFeedSecurityInput = {
    ...buildBaseFeedInput(),
    configuredMaxExposureStroops: 200_000n * STROOPS_PER_UNIT, // Requires 400k attack cost at 2x
  };

  assert.throws(
    () => validateFeedExposureAgainstAttackCost([unsafeFeed]),
    /ORACLE_SECURITY_VIOLATION/
  );

  const dryRunReport = validateFeedExposureAgainstAttackCost([unsafeFeed], { dryRun: true });
  assert.equal(dryRunReport.passed, false);
  assert.equal(dryRunReport.criticalAlerts.length, 1);

  const rows = generateSensitivityRows();
  assert.equal(rows.length >= 3, true);
  const markdown = renderSensitivityMarkdown(rows);
  assert.equal(markdown.includes("source_collusion"), true);
});
