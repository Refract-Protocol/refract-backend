export type Severity = "low" | "medium" | "high" | "triggered";

/**
 * A reference to an entity described by a reading, as supplied by the upstream
 * provider. The provider-native identifier must be resolved against the
 * versioned reference data registry before the reading can be counted toward
 * consensus.
 */
export interface ReadingEntityReference {
  /** Entity kind, e.g. "airport", "route", "carrier", "protocol", "market", "chain", "asset". */
  type: string;
  /** Provider that issued the native identifier, e.g. "nexus", "aviationstack". */
  provider: string;
  /** Provider-specific identifier that must be resolved to a canonical ID. */
  providerNativeId: string;
}

/**
 * Outcome of validating a reading's entity references against the reference
 * data registry. Readings start `pending` and are only eligible for consensus
 * once `accepted`.
 */
export type ReadingValidationStatus = "pending" | "accepted" | "rejected";

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
   * Entity references supplied by the upstream provider. Validated at
   * ingestion time against the pinned reference dataset version.
   */
  entities?: ReadingEntityReference[];
  /**
   * Reference dataset version the reading must be validated against. Pinned so
   * that a later dataset refresh cannot retroactively change how a past
   * reading was interpreted.
   */
  referenceDatasetVersion?: string;
  /**
   * Canonical entity IDs populated after successful resolution against the
   * reference data registry. Order corresponds to `entities`.
   */
  canonicalEntityIds?: string[];
  /**
   * Validation state of the reading's entity references. Defaults to
   * `pending` when entity references are present and validation has not yet
   * run.
   */
  validationStatus?: ReadingValidationStatus;
  /**
   * Human-readable reason a reading was rejected. Present only when
   * `validationStatus === "rejected"`; used for dead-letter routing.
   */
  rejectionReason?: string;
}