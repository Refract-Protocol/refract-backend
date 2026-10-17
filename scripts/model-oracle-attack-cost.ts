/**
 * CLI Sensitivity Table Generator for Oracle Attack-Cost & Bond Sizing (Issue #288)
 */

import {
  evaluateOracleAttackCost,
  STROOPS_PER_UNIT,
  type OracleFeedSecurityInput,
} from "../src/oracle/security/attack-cost.model.ts";

export interface SensitivityRow {
  scenario: string;
  sourceCount: number;
  sourceQuorum: number;
  independentGroups: number;
  operatorQuorum: string;
  operatorBondUnits: string;
  minAttackCostUnits: string;
  limitingVector: string;
  maxSupportedExposureUnits: string;
  impliedMinBondUnits: string;
  isExposureSafe: boolean;
}

function formatUnits(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  return whole.toString();
}

export function generateSensitivityRows(): SensitivityRow[] {
  const scenarios: Array<{ label: string; input: OracleFeedSecurityInput; independentGroups: number }> = [
    {
      label: "Baseline (5 independent sources, 3/5 quorum, 3/5 operators, 50k bond)",
      independentGroups: 5,
      input: {
        feedId: "market_crash_index",
        sources: [1, 2, 3, 4, 5].map((i) => ({
          sourceId: `src_${i}`,
          weight: 1,
          briberyCostStroops: 80_000n * STROOPS_PER_UNIT,
          independenceGroup: `vendor_${i}`,
        })),
        sourceQuorumCount: 3,
        operatorCount: 5,
        operatorQuorumCount: 3,
        operatorBondStroops: 50_000n * STROOPS_PER_UNIT,
        keyCompromiseFloorStroops: 20_000n * STROOPS_PER_UNIT,
        configuredMaxExposureStroops: 100_000n * STROOPS_PER_UNIT,
      },
    },
    {
      label: "Shared Upstream Collusion (3 of 5 sources share vendor_shared)",
      independentGroups: 3,
      input: {
        feedId: "market_crash_index",
        sources: [
          { sourceId: "src_1", weight: 1, briberyCostStroops: 80_000n * STROOPS_PER_UNIT, independenceGroup: "vendor_shared" },
          { sourceId: "src_2", weight: 1, briberyCostStroops: 80_000n * STROOPS_PER_UNIT, independenceGroup: "vendor_shared" },
          { sourceId: "src_3", weight: 1, briberyCostStroops: 80_000n * STROOPS_PER_UNIT, independenceGroup: "vendor_shared" },
          { sourceId: "src_4", weight: 1, briberyCostStroops: 80_000n * STROOPS_PER_UNIT, independenceGroup: "vendor_2" },
          { sourceId: "src_5", weight: 1, briberyCostStroops: 80_000n * STROOPS_PER_UNIT, independenceGroup: "vendor_3" },
        ],
        sourceQuorumCount: 3,
        operatorCount: 5,
        operatorQuorumCount: 3,
        operatorBondStroops: 50_000n * STROOPS_PER_UNIT,
        keyCompromiseFloorStroops: 20_000n * STROOPS_PER_UNIT,
        configuredMaxExposureStroops: 100_000n * STROOPS_PER_UNIT,
      },
    },
    {
      label: "High Bond & 5/7 Operator Quorum (100k bond, 5/7 quorum)",
      independentGroups: 7,
      input: {
        feedId: "stablecoin_depeg_usdc",
        sources: [1, 2, 3, 4, 5, 6, 7].map((i) => ({
          sourceId: `src_${i}`,
          weight: 1,
          briberyCostStroops: 120_000n * STROOPS_PER_UNIT,
          independenceGroup: `vendor_${i}`,
        })),
        sourceQuorumCount: 5,
        operatorCount: 7,
        operatorQuorumCount: 5,
        operatorBondStroops: 100_000n * STROOPS_PER_UNIT,
        keyCompromiseFloorStroops: 25_000n * STROOPS_PER_UNIT,
        configuredMaxExposureStroops: 250_000n * STROOPS_PER_UNIT,
      },
    },
  ];

  return scenarios.map(({ label, input, independentGroups }) => {
    const res = evaluateOracleAttackCost(input);
    return {
      scenario: label,
      sourceCount: input.sources.length,
      sourceQuorum: input.sourceQuorumCount,
      independentGroups,
      operatorQuorum: `${input.operatorQuorumCount}/${input.operatorCount}`,
      operatorBondUnits: formatUnits(input.operatorBondStroops),
      minAttackCostUnits: formatUnits(res.minAttackCostStroops),
      limitingVector: res.limitingVector,
      maxSupportedExposureUnits: formatUnits(res.maxSupportedExposureStroops),
      impliedMinBondUnits: formatUnits(res.impliedMinOperatorBondStroops),
      isExposureSafe: res.isExposureSafe,
    };
  });
}

export function renderSensitivityMarkdown(rows: SensitivityRow[]): string {
  const header =
    "| Scenario | N | K_src | Indep. Groups | K_op/M | Bond (units) | Min Attack Cost | Limiting Vector | Max Exposure (2x) | Implied Min Bond | Safe? |\n" +
    "|---|---:|---:|---:|---|---:|---:|---|---:|---:|---|";
  const lines = rows.map(
    (r) =>
      `| ${r.scenario} | ${r.sourceCount} | ${r.sourceQuorum} | ${r.independentGroups} | ${r.operatorQuorum} | ${r.operatorBondUnits} | ${r.minAttackCostUnits} | ${r.limitingVector} | ${r.maxSupportedExposureUnits} | ${r.impliedMinBondUnits} | ${r.isExposureSafe ? "YES" : "NO"} |`
  );
  return [header, ...lines].join("\n");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const format = process.argv.includes("--json") ? "json" : "markdown";
  const rows = generateSensitivityRows();
  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(renderSensitivityMarkdown(rows));
  }
}
