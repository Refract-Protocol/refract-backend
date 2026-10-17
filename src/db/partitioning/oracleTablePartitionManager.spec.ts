import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertBoundedPartitionQuery,
  generatePartitionAndIndexDdl,
  planMonthlyPartitions,
} from "./oracleTablePartitionManager.ts";

test("generatePartitionAndIndexDdl and planMonthlyPartitions produce range partitions and covering indexes", () => {
  const ddl = generatePartitionAndIndexDdl();
  assert.equal(ddl.length, 5);
  assert.ok(ddl[0].includes("PARTITION BY RANGE (observed_at)"));
  assert.ok(ddl[2].includes("PARTITION BY RANGE (recorded_at)"));

  // Nov 2026 + 2 months ahead -> Nov 2026, Dec 2026, Jan 2027
  const nov2026Ms = Date.UTC(2026, 10, 15, 12, 0, 0);
  const partitions = planMonthlyPartitions({
    table: "oracle_source_readings",
    nowMs: nov2026Ms,
    monthsAhead: 2,
  });

  assert.equal(partitions.length, 3);
  assert.deepEqual(
    partitions.map((p) => p.partitionName),
    [
      "oracle_source_readings_p2026_11",
      "oracle_source_readings_p2026_12",
      "oracle_source_readings_p2027_01",
    ]
  );
  assert.ok(partitions[2].ddl.includes("2027-01-01T00:00:00.000Z"));
  assert.ok(partitions[2].ddl.includes("2027-02-01T00:00:00.000Z"));
});

test("assertBoundedPartitionQuery enforces query-budget bounds and computes pruned partitions", () => {
  // Missing timestamp range fails loudly
  assert.throws(
    () =>
      assertBoundedPartitionQuery({
        table: "oracle_source_readings",
        startMs: undefined,
        endMs: undefined,
      }),
    /UNBOUNDED_PARTITION_SCAN_REJECTED/
  );

  // Oversized window exceeding query budget fails loudly
  assert.throws(
    () =>
      assertBoundedPartitionQuery({
        table: "oracle_evidence_ledger",
        startMs: Date.UTC(2026, 0, 1),
        endMs: Date.UTC(2026, 5, 1),
        maxRangeMs: 31 * 24 * 60 * 60 * 1000,
      }),
    /QUERY_BUDGET_EXCEEDED/
  );

  // Valid consensus window touches only expected monthly partition(s)
  const valid = assertBoundedPartitionQuery({
    table: "oracle_source_readings",
    startMs: Date.UTC(2026, 9, 17, 10, 0, 0),
    endMs: Date.UTC(2026, 9, 17, 11, 0, 0),
  });
  assert.deepEqual(valid.prunedPartitions, ["oracle_source_readings_p2026_10"]);
});
