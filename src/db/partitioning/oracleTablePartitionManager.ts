export type PartitionedOracleTable =
  | "oracle_source_readings"
  | "oracle_evidence_ledger";

export interface MonthlyPartitionSpec {
  parentTable: PartitionedOracleTable;
  partitionName: string;
  rangeStartIso: string;
  rangeEndIso: string;
  ddl: string;
}

export interface BoundedQueryWindow {
  table: PartitionedOracleTable;
  startMs?: number;
  endMs?: number;
  maxRangeMs?: number;
}

function formatYearMonth(year: number, monthZeroIndexed: number): {
  suffix: string;
  startIso: string;
  endIso: string;
} {
  const startDate = new Date(Date.UTC(year, monthZeroIndexed, 1, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, monthZeroIndexed + 1, 1, 0, 0, 0));
  const yyyy = startDate.getUTCFullYear();
  const mm = String(startDate.getUTCMonth() + 1).padStart(2, "0");
  return {
    suffix: `${yyyy}_${mm}`,
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
  };
}

/**
 * Generates canonical declarative partitioning and covering index DDL for
 * `oracle_source_readings` and `oracle_evidence_ledger`.
 */
export function generatePartitionAndIndexDdl(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS oracle_source_readings (
  reading_id TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  value NUMERIC NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  payload_digest TEXT NOT NULL,
  PRIMARY KEY (feed_id, source_id, observed_at, payload_digest)
) PARTITION BY RANGE (observed_at);`,
    `CREATE INDEX IF NOT EXISTS idx_oracle_readings_consensus_window
  ON oracle_source_readings (feed_id, source_id, observed_at DESC)
  INCLUDE (value, payload_digest);`,
    `CREATE TABLE IF NOT EXISTS oracle_evidence_ledger (
  evidence_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (evidence_id, recorded_at)
) PARTITION BY RANGE (recorded_at);`,
    `CREATE INDEX IF NOT EXISTS idx_oracle_evidence_by_decision
  ON oracle_evidence_ledger (decision_id, recorded_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_oracle_evidence_trust_status
  ON oracle_evidence_ledger (feed_id, recorded_at DESC);`,
  ];
}

/**
 * Plans monthly partitions for the current month and `monthsAhead` future months.
 */
export function planMonthlyPartitions(params: {
  table: PartitionedOracleTable;
  nowMs: number;
  monthsAhead: number;
}): MonthlyPartitionSpec[] {
  const baseDate = new Date(params.nowMs);
  const startYear = baseDate.getUTCFullYear();
  const startMonth = baseDate.getUTCMonth();
  const specs: MonthlyPartitionSpec[] = [];

  for (let offset = 0; offset <= params.monthsAhead; offset++) {
    const { suffix, startIso, endIso } = formatYearMonth(
      startYear,
      startMonth + offset
    );
    const partitionName = `${params.table}_p${suffix}`;
    const ddl = `CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF ${params.table} FOR VALUES FROM ('${startIso}') TO ('${endIso}');`;
    specs.push({
      parentTable: params.table,
      partitionName,
      rangeStartIso: startIso,
      rangeEndIso: endIso,
      ddl,
    });
  }

  return specs;
}

/**
 * Enforces the query-budget policy: every query against partitioned oracle tables
 * must include a bounded timestamp range so PostgreSQL partition pruning is guaranteed.
 */
export function assertBoundedPartitionQuery(
  window: BoundedQueryWindow
): { prunedPartitions: string[] } {
  if (
    typeof window.startMs !== "number" ||
    typeof window.endMs !== "number" ||
    !Number.isFinite(window.startMs) ||
    !Number.isFinite(window.endMs)
  ) {
    throw new Error(
      `UNBOUNDED_PARTITION_SCAN_REJECTED: Query on '${window.table}' must specify both startMs and endMs`
    );
  }

  if (window.endMs < window.startMs) {
    throw new Error(
      `INVALID_QUERY_WINDOW: endMs (${window.endMs}) precedes startMs (${window.startMs})`
    );
  }

  const maxRangeMs = window.maxRangeMs ?? 31 * 24 * 60 * 60 * 1000; // default 31 days
  if (window.endMs - window.startMs > maxRangeMs) {
    throw new Error(
      `QUERY_BUDGET_EXCEEDED: Range ${window.endMs - window.startMs}ms exceeds budget ${maxRangeMs}ms on '${window.table}'`
    );
  }

  // Compute the exact monthly partitions touched by [startMs, endMs]
  const startDate = new Date(window.startMs);
  const endDate = new Date(window.endMs);
  const prunedPartitions: string[] = [];

  let cursorYear = startDate.getUTCFullYear();
  let cursorMonth = startDate.getUTCMonth();
  const endYear = endDate.getUTCFullYear();
  const endMonth = endDate.getUTCMonth();

  while (
    cursorYear < endYear ||
    (cursorYear === endYear && cursorMonth <= endMonth)
  ) {
    const { suffix } = formatYearMonth(cursorYear, cursorMonth);
    prunedPartitions.push(`${window.table}_p${suffix}`);
    cursorMonth += 1;
    if (cursorMonth > 11) {
      cursorMonth = 0;
      cursorYear += 1;
    }
  }

  return { prunedPartitions };
}
