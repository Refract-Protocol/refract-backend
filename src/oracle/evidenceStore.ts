export interface OracleEvidenceReadingRecord {
  readonly readingId: string;
  readonly sourceId: string;
  readonly coverageType: string;
  readonly rawPayloadTruncated: string;
  readonly payloadWasTruncated: boolean;
  readonly normalizedValue: number;
  readonly observedAtMs: number;
  readonly ingestedAtMs: number;
}

export type DecisionSettlementStatus =
  | "pending_settlement"
  | "settled_on_chain"
  | "settlement_failed";

export interface OracleDecisionRecord {
  readonly decisionId: string;
  readonly coverageType: string;
  readonly contributingReadingIds: readonly string[];
  readonly chosenValue: number;
  readonly ruleApplied: string;
  readonly claimId: string;
  readonly createdAtMs: number;
  settlementStatus: DecisionSettlementStatus;
  settlementTxHash?: string;
  settledAtMs?: number;
}

const SECRET_PATTERNS = [
  /("?(?:api[_-]?key|secret|token|authorization|password)"?\s*:\s*")([^"]+)(")/gi,
  /(Bearer\s+)[A-Za-z0-9._\-]+/gi,
];

export function sanitizeAndCapRawPayload(
  rawPayload: string,
  maxBytes: number = 4_096
): { sanitized: string; truncated: boolean } {
  let cleaned = rawPayload;
  cleaned = cleaned.replace(SECRET_PATTERNS[0]!, "$1[REDACTED]$3");
  cleaned = cleaned.replace(SECRET_PATTERNS[1]!, "$1[REDACTED]");

  const buf = Buffer.from(cleaned, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { sanitized: cleaned, truncated: false };
  }
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return { sanitized: `${sliced}...[TRUNCATED]`, truncated: true };
}

export function buildOracleEvidenceMigrationSql(): string {
  return `
CREATE TABLE IF NOT EXISTS oracle_evidence (
  reading_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  coverage_type TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  payload_was_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  normalized_value DOUBLE PRECISION NOT NULL,
  observed_at_ms BIGINT NOT NULL,
  ingested_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oracle_decisions (
  decision_id TEXT PRIMARY KEY,
  coverage_type TEXT NOT NULL,
  contributing_reading_ids TEXT[] NOT NULL,
  chosen_value DOUBLE PRECISION NOT NULL,
  rule_applied TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  settlement_status TEXT NOT NULL,
  settlement_tx_hash TEXT,
  settled_at_ms BIGINT
);
`.trim();
}

export class AppendOnlyEvidenceStore {
  private readonly evidenceById = new Map<string, OracleEvidenceReadingRecord>();
  private readonly decisionsById = new Map<string, OracleDecisionRecord>();
  private readonly maxRawPayloadBytes: number;
  private seq = 0;

  constructor(options?: { maxRawPayloadBytes?: number }) {
    this.maxRawPayloadBytes = options?.maxRawPayloadBytes ?? 4_096;
  }

  public appendReading(params: {
    sourceId: string;
    coverageType: string;
    rawPayload: string;
    normalizedValue: number;
    observedAtMs: number;
    ingestedAtMs?: number;
  }): OracleEvidenceReadingRecord {
    const ingestedAtMs = params.ingestedAtMs ?? Date.now();
    const { sanitized, truncated } = sanitizeAndCapRawPayload(
      params.rawPayload,
      this.maxRawPayloadBytes
    );

    this.seq += 1;
    const record: OracleEvidenceReadingRecord = Object.freeze({
      readingId: `ev-${this.seq}`,
      sourceId: params.sourceId,
      coverageType: params.coverageType,
      rawPayloadTruncated: sanitized,
      payloadWasTruncated: truncated,
      normalizedValue: params.normalizedValue,
      observedAtMs: params.observedAtMs,
      ingestedAtMs,
    });

    this.evidenceById.set(record.readingId, record);
    return record;
  }

  public recordDecisionBeforeSettlement(params: {
    coverageType: string;
    contributingReadingIds: string[];
    chosenValue: number;
    ruleApplied: string;
    claimId: string;
    createdAtMs?: number;
  }): OracleDecisionRecord {
    if (params.contributingReadingIds.length === 0) {
      throw new Error(
        "Cannot record oracle decision without at least one contributing readingId"
      );
    }

    for (const rid of params.contributingReadingIds) {
      if (!this.evidenceById.has(rid)) {
        throw new Error(`Referenced readingId ${rid} does not exist in evidence ledger`);
      }
    }

    this.seq += 1;
    const decision: OracleDecisionRecord = {
      decisionId: `dec-${this.seq}`,
      coverageType: params.coverageType,
      contributingReadingIds: Object.freeze([...params.contributingReadingIds]),
      chosenValue: params.chosenValue,
      ruleApplied: params.ruleApplied,
      claimId: params.claimId,
      createdAtMs: params.createdAtMs ?? Date.now(),
      settlementStatus: "pending_settlement",
    };

    this.decisionsById.set(decision.decisionId, decision);
    return { ...decision };
  }

  public backfillSettlementOutcome(params: {
    decisionId: string;
    settlementStatus: "settled_on_chain" | "settlement_failed";
    settlementTxHash?: string;
    settledAtMs?: number;
  }): OracleDecisionRecord {
    const decision = this.decisionsById.get(params.decisionId);
    if (!decision) {
      throw new Error(`Unknown decisionId: ${params.decisionId}`);
    }
    if (decision.settlementStatus !== "pending_settlement") {
      throw new Error(
        `APPEND_ONLY_VIOLATION: settlement outcome for ${params.decisionId} is already finalized`
      );
    }
    if (
      params.settlementStatus === "settled_on_chain" &&
      (!params.settlementTxHash || params.settlementTxHash.trim().length === 0)
    ) {
      throw new Error("settled_on_chain requires a valid settlementTxHash");
    }

    decision.settlementStatus = params.settlementStatus;
    decision.settlementTxHash = params.settlementTxHash;
    decision.settledAtMs = params.settledAtMs ?? Date.now();
    return { ...decision };
  }

  public attemptMutateOrDeleteEvidence(_readingId: string): never {
    throw new Error(
      "APPEND_ONLY_VIOLATION: UPDATE and DELETE are prohibited on oracle_evidence"
    );
  }

  public getAuditChainForDecision(decisionId: string): {
    decision: OracleDecisionRecord;
    readings: OracleEvidenceReadingRecord[];
  } {
    const decision = this.decisionsById.get(decisionId);
    if (!decision) {
      throw new Error(`Unknown decisionId: ${decisionId}`);
    }
    const readings = decision.contributingReadingIds.map(
      (id) => this.evidenceById.get(id)!
    );
    return {
      decision: { ...decision },
      readings,
    };
  }
}
