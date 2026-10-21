import { SourceObservation } from "./adapters/source-adapter";

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
  /** Source IDs that contributed to `value`, e.g. ["coingecko"]. */
  sources?: string[];
  /** Canonicalized observations (with HTTP evidence) behind this reading. */
  observations?: SourceObservation[];
}
