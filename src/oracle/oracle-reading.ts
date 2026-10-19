export type Severity = "low" | "medium" | "high" | "triggered";

export interface OracleReading {
  coverageType: string;
  type: "oracle_update";
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
  /**
   * True when this reading came from the fail-safe fallback (upstream outage).
   * OraclePublisherService must never publish degraded readings on-chain.
   */
  degraded?: boolean;
  /**
   * Upstream observation time (ISO-8601 with explicit offset, or a Date).
   * Consensus uses this; readings without it are rejected at ingestion.
   */
  observedAt?: string | Date;
}
