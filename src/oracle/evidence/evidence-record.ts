/**
 * Evidence records are the unit of the oracle audit trail. Every record gets
 * a strictly increasing `seq` at the moment it is accepted, before it is
 * written anywhere, so the trail is totally ordered and any loss shows up as
 * a hole in the sequence (and as an explicit gap record).
 */

export type EvidenceKind = "reading" | "decision";

/** Coverage types the evidence store can persist (PascalCase → coverage_type enum). */
export const EVIDENCE_COVERAGE_TYPES: Readonly<Record<string, string>> = {
  StablecoinDepeg: "stablecoin_depeg",
  MarketCrash: "market_crash",
  LiquidationShield: "liquidation_shield",
  SmartContractRisk: "smart_contract_risk",
  FlightDelay: "flight_delay",
};

export interface EvidenceEntry {
  kind: EvidenceKind;
  /** PascalCase coverage type, e.g. "StablecoinDepeg". */
  coverageType: string;
  value: number;
  severity: string;
  /** Primary source tag, e.g. "coingecko" or "consensus". */
  source: string;
  /** When the evidence was produced (ms). Stored as recorded_at. */
  recordedAt: number;
  /** Full structured payload: the reading or decision with its observations. */
  payload: unknown;
}

export interface SequencedEvidence extends EvidenceEntry {
  seq: number;
}

/** Marks a run of sequence numbers that could not be made durable. */
export interface EvidenceGap {
  seq: number;
  kind: "gap";
  firstSeq: number;
  lastSeq: number;
  lostCount: number;
  openedAt: number;
  closedAt: number;
  reason: string;
  recordedAt: number;
}

export type EvidenceRecord = SequencedEvidence | EvidenceGap;

export function isGap(record: EvidenceRecord): record is EvidenceGap {
  return record.kind === "gap";
}

/** Persists records to the system of record (Postgres). Must be idempotent per seq and throw on failure. */
export interface EvidenceStore {
  persist(records: EvidenceRecord[]): Promise<void>;
}

export const EVIDENCE_STORE = Symbol("EVIDENCE_STORE");

/** Thrown when evidence could not be written durably; callers must treat the action it supports as unproven. */
export class EvidenceNotDurableError extends Error {
  constructor(detail: string) {
    super(`Oracle evidence could not be made durable: ${detail}`);
    this.name = "EvidenceNotDurableError";
  }
}
