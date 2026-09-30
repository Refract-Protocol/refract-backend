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
