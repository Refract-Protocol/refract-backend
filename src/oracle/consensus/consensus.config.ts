/**
 * Environment-driven settings for the consensus evidence layer.
 *
 * Read straight from process.env (rather than the typed ConfigService) so the
 * module and the operator CLI resolve identical values.
 */
export interface ConsensusConfig {
  /** JSONL file backing the evidence ledger. Unset → in-memory only. */
  ledgerPath?: string;
  /** Directory for content-addressed raw payload bodies. Unset → in-memory. */
  payloadDir?: string;
  /** How often held claims are re-evaluated. */
  holdReevaluateIntervalMs: number;
  /** Maximum time a claim may stay held before escalating to an operator. */
  holdMaxDurationMs: number;
}

export function loadConsensusConfig(env: NodeJS.ProcessEnv = process.env): ConsensusConfig {
  return {
    ledgerPath: env.EVIDENCE_LEDGER_PATH?.trim() || undefined,
    payloadDir: env.EVIDENCE_PAYLOAD_DIR?.trim() || undefined,
    holdReevaluateIntervalMs: positiveInt(env.CLAIM_HOLD_REEVALUATE_INTERVAL_MS, 60_000),
    holdMaxDurationMs: positiveInt(env.CLAIM_HOLD_MAX_DURATION_MS, 24 * 60 * 60 * 1000),
  };
}

export function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Expected a positive number, got "${raw}"`);
  return Math.floor(n);
}

export function positiveFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Expected a non-negative number, got "${raw}"`);
  return n;
}

export const EVIDENCE_LEDGER = Symbol("EVIDENCE_LEDGER");
export const PAYLOAD_STORE = Symbol("PAYLOAD_STORE");
export const CONSENSUS_CONFIG = Symbol("CONSENSUS_CONFIG");
