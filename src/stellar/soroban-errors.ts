/**
 * Typed Soroban RPC / contract error hierarchy so callers can map failures
 * to the right HTTP status instead of collapsing everything into a generic 400.
 */

export class SorobanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Network blips, 5xx, timeouts — safe to retry; maps to 503 after exhaustion. */
export class SorobanTransientError extends SorobanError {}

/** RPC provider 429 — maps to HTTP 429 with Retry-After. */
export class SorobanRateLimitError extends SorobanError {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

/** Contract / simulation rejection — never retried; maps to HTTP 400. */
export class SorobanContractError extends SorobanError {}

/** Account / ledger entry not found — maps to HTTP 404 where appropriate. */
export class SorobanNotFoundError extends SorobanError {}

/**
 * Simulation asked for a RestoreFootprint before the real invoke can proceed.
 * User-signed flows surface this so the client can sign the restore XDR first;
 * relayer-signed flows handle it automatically inside SorobanRpcService.
 */
export class SorobanRestoreRequiredError extends SorobanError {
  constructor(
    message: string,
    public readonly restoreXdr: string,
    public readonly estimatedFee: string
  ) {
    super(message);
  }
}

/** Restore fee exceeded the configured ceiling — refuse rather than grief the relayer. */
export class SorobanRestoreFeeExceededError extends SorobanError {
  constructor(
    message: string,
    public readonly estimatedFee: string,
    public readonly feeCeiling: string
  ) {
    super(message);
  }
}
