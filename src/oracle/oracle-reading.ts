import type { ReadingProvenance } from "./oracle-encoding";
import { FreshnessRejectionReason } from "./freshnessPolicy";

export type Severity = "low" | "medium" | "high" | "triggered";

export interface OracleEvidenceMetadata {
  adapter: string;
  schemaVersion: number;
  digest: string;
  attribution: string;
  sensitivity: "public" | "commercial" | "personal" | "synthetic";
}

export interface OracleReading {
  readingId?: string;
  coverageType: string;
  type: "oracle_update";
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
  feedId?: string;
  source?: string;
  timestamp?: number;
  deadlineAt?: number;
  fetchDurationMs?: number;
  /**
   * True when this reading came from the fail-safe fallback (upstream outage).
   * OraclePublisherService must never publish degraded readings on-chain.
   */
  degraded?: boolean;
  /**
   * Consensus provenance (trust tier, agreeing source count, decision id,
   * source timestamp). Present only for readings that reached consensus;
   * published on-chain next to the value. Never set on degraded readings.
   */
  provenance?: ReadingProvenance;
  /**
   * Upstream observation time (ISO-8601 with explicit offset, or a Date).
   * Consensus uses this; readings without it are rejected at ingestion.
   */
  observedAt?: string | Date;
  /**
   * False when the freshness guard rejected this reading (issue #186). Such
   * readings are persisted for audit but excluded from corroboration.
   */
  usable?: boolean;
  rejectionReason?: FreshnessRejectionReason;
}
