export type SettlementErrorClass = "transient" | "permanent" | "indeterminate";

export interface SettlementAttemptRecord {
  policyId: string;
  holder: string;
  attemptCount: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  lastError?: string;
  lastErrorClass?: SettlementErrorClass;
  /** Pending tx hash from an indeterminate confirmation timeout — re-query before retry. */
  pendingTxHash?: string;
  deadLettered: boolean;
  deadLetteredAt?: number;
  errorHistory: Array<{
    at: number;
    error: string;
    classification: SettlementErrorClass;
  }>;
}

/**
 * A single entry in a dead-lettered claim's full attempt log, surfaced to
 * admins so they can inspect the failure history before acting.
 */
export interface SettlementAttemptLogEntry {
  attempt: number;
  at: number;
  error?: string;
  classification: SettlementErrorClass;
  /** Pending tx hash recorded for an indeterminate attempt, if any. */
  pendingTxHash?: string;
}

/**
 * A manual admin action taken against a dead-lettered claim. Every action is
 * recorded so the admin audit log can trace manual retries/write-offs exactly
 * like automated settlement attempts.
 */
export type DeadLetterAdminAction = "retry" | "write_off";

export interface DeadLetterAdminActionRecord {
  action: DeadLetterAdminAction;
  policyId: string;
  actor: string;
  at: number;
  /** Required for write-offs; the recorded reason the claim is unresolved. */
  reason?: string;
  /** Outcome of a manual retry, when applicable. */
  outcome?: "succeeded" | "failed" | "rejected";
  /** Error surfaced by a failed manual retry, when applicable. */
  error?: string;
}

/** Default retry budget for a settlement attempt record. */
export const DEFAULT_MAX_SETTLEMENT_ATTEMPTS = 3;

/**
 * Returns true once the attempt counter has reached the configured cap, i.e.
 * no further retry may be scheduled. The counter is 1-based (it is incremented
 * after each failed attempt), so the cap is reached when
 * `attemptCount >= maxAttempts` — not when it exceeds it.
 */
export function isAttemptCapReached(
  attemptCount: number,
  maxAttempts: number = DEFAULT_MAX_SETTLEMENT_ATTEMPTS,
): boolean {
  const cap = Number.isFinite(maxAttempts) && maxAttempts > 0
    ? Math.floor(maxAttempts)
    : DEFAULT_MAX_SETTLEMENT_ATTEMPTS;
  return attemptCount >= cap;
}

/**
 * Builds the ordered attempt log for a dead-lettered claim from its recorded
 * error history, so admins can inspect the full failure trail.
 */
export function buildAttemptLog(
  record: SettlementAttemptRecord,
): SettlementAttemptLogEntry[] {
  return record.errorHistory.map((entry, index) => ({
    attempt: index + 1,
    at: entry.at,
    error: entry.error,
    classification: entry.classification,
    pendingTxHash:
      entry.classification === "indeterminate" ? record.pendingTxHash : undefined,
  }));
}

/**
 * Classifies settlement failures so permanent errors dead-letter immediately
 * while transient ones consume the retry budget.
 */
export function classifySettlementError(error: string | undefined): SettlementErrorClass {
  if (!error) return "transient";
  const lower = error.toLowerCase();

  if (
    lower.includes("timed out waiting for confirmation") ||
    lower.includes("indeterminate")
  ) {
    return "indeterminate";
  }

  if (
    lower.includes("argument") ||
    lower.includes("arity") ||
    lower.includes("unknown policy") ||
    lower.includes("invalid policy") ||
    lower.includes("contract error") ||
    lower.includes("hosterror") ||
    lower.includes("unreachable") || // wrong WASM export
    lower.includes("missing_value") ||
    lower.includes("txmalformed") ||
    lower.includes("permanent")
  ) {
    return "permanent";
  }

  if (
    lower.includes("try_again_later") ||
    lower.includes("congest") ||
    lower.includes("connection") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("503") ||
    lower.includes("insufficient_fee") ||
    lower.includes("txinsufficient_fee")
  ) {
    return "transient";
  }

  // Default: treat unknown failures as transient so we don't dead-letter
  // on the first blip — budget exhaustion still bounds the loop.
  return "transient";
}
