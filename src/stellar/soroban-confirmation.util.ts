import { rpc, xdr } from "@stellar/stellar-sdk";

/**
 * Outcome discriminant for a confirmation poll. Callers must distinguish
 * "definitely failed on-chain" (do not retry the same envelope) from
 * "unknown — deadline exceeded while still NOT_FOUND" (safe to re-check
 * later). Both previously collapsed into `confirmed: false`.
 */
export type ConfirmationOutcome =
  | "success"
  | "failed_on_chain"
  | "not_found_yet_deadline_exceeded"
  | "aborted";

export interface ConfirmationResult {
  /** Convenience mirror of `outcome === "success"`. */
  confirmed: boolean;
  outcome: ConfirmationOutcome;
  txHash: string;
  error?: string;
  /**
   * Raw Soroban return value from a successful getTransaction, when the
   * RPC includes one. Callers decode with `scValToNative` (u64 policy ids
   * must stay as bigint — never coerce through Number).
   */
  returnValue?: xdr.ScVal;
}

/** Tunables for a single pollForConfirmation call. */
export interface ConfirmationPollOptions {
  /** First sleep before the second getTransaction (ms). Default 400. */
  initialIntervalMs?: number;
  /** Multiplier applied after each NOT_FOUND / transient error. Default 1.8. */
  backoffMultiplier?: number;
  /** Cap on the sleep interval (ms). Default 8_000. */
  maxIntervalMs?: number;
  /**
   * Wall-clock deadline from poll start (ms). Not an attempt count — a
   * slow RPC must not silently extend the wait. Default 30_000.
   */
  deadlineMs?: number;
  /**
   * Fractional jitter applied to each sleep: interval * (1 ± jitterRatio).
   * Required so concurrent settlements don't storm the RPC in lockstep.
   * Default 0.2.
   */
  jitterRatio?: number;
  /** Floor under the post-jitter sleep so aggressive early polling still respects rate limits. Default 100. */
  minIntervalMs?: number;
  /** Optional abort — graceful shutdown stops polling promptly. */
  signal?: AbortSignal;
  /** Injected clock/sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Injected RNG for jitter; returns [0, 1). */
  random?: () => number;
}

export const DEFAULT_CONFIRMATION_POLL: Required<
  Omit<ConfirmationPollOptions, "signal" | "sleep" | "now" | "random">
> = {
  initialIntervalMs: 400,
  backoffMultiplier: 1.8,
  maxIntervalMs: 8_000,
  deadlineMs: 30_000,
  jitterRatio: 0.2,
  minIntervalMs: 100,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(intervalMs: number, jitterRatio: number, minIntervalMs: number, random: () => number): number {
  const delta = intervalMs * jitterRatio * (2 * random() - 1);
  return Math.max(minIntervalMs, Math.round(intervalMs + delta));
}

/**
 * Polls a submitted Soroban transaction until it lands SUCCESS/FAILED,
 * the wall-clock deadline elapses, or the optional AbortSignal fires.
 *
 * Shared by every path that submits a transaction and needs to know
 * whether it actually landed on-chain (ClaimSettlementService's
 * relayer-signed process_claim / oracle updates, and TxService's
 * client-signed submits).
 *
 * NOT_FOUND early in the window is normal — Soroban ledgers close ~5s
 * and RPC history is eventually consistent — and is never treated as
 * failure. Transient getTransaction throws (RPC blips) are retried
 * inside the deadline rather than propagating out of the loop.
 */
export async function pollForConfirmation(
  server: rpc.Server,
  hash: string,
  options: ConfirmationPollOptions = {}
): Promise<ConfirmationResult> {
  const {
    initialIntervalMs = DEFAULT_CONFIRMATION_POLL.initialIntervalMs,
    backoffMultiplier = DEFAULT_CONFIRMATION_POLL.backoffMultiplier,
    maxIntervalMs = DEFAULT_CONFIRMATION_POLL.maxIntervalMs,
    deadlineMs = DEFAULT_CONFIRMATION_POLL.deadlineMs,
    jitterRatio = DEFAULT_CONFIRMATION_POLL.jitterRatio,
    minIntervalMs = DEFAULT_CONFIRMATION_POLL.minIntervalMs,
    signal,
    sleep = defaultSleep,
    now = Date.now,
    random = Math.random,
  } = options;

  const deadlineAt = now() + deadlineMs;
  let intervalMs = initialIntervalMs;

  // Immediate first probe — no sleep before attempt 0 — then back off.
  for (;;) {
    if (signal?.aborted) {
      return { confirmed: false, outcome: "aborted", txHash: hash, error: "Confirmation polling aborted" };
    }

    try {
      const result = await server.getTransaction(hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const success = result as rpc.Api.GetSuccessfulTransactionResponse;
        return {
          confirmed: true,
          outcome: "success",
          txHash: hash,
          returnValue: success.returnValue,
        };
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        return {
          confirmed: false,
          outcome: "failed_on_chain",
          txHash: hash,
          error: "Transaction failed on-chain",
        };
      }
      // NOT_FOUND (and any other non-terminal status): keep polling.
    } catch {
      // Transient RPC failure — retry within the deadline.
    }

    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      return {
        confirmed: false,
        outcome: "not_found_yet_deadline_exceeded",
        txHash: hash,
        error: "Timed out waiting for confirmation",
      };
    }

    const sleepMs = Math.min(withJitter(intervalMs, jitterRatio, minIntervalMs, random), remaining);
    await sleep(sleepMs);

    if (signal?.aborted) {
      return { confirmed: false, outcome: "aborted", txHash: hash, error: "Confirmation polling aborted" };
    }

    intervalMs = Math.min(maxIntervalMs, intervalMs * backoffMultiplier);
  }
}
