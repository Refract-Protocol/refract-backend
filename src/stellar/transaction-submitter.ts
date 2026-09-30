import { Logger } from "@nestjs/common";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { ConfirmationResult, pollForConfirmation } from "./soroban-confirmation.util";

const logger = new Logger("TransactionSubmitter");

/** Permanent rejection — never retry the same envelope. */
export class TxSubmissionError extends Error {
  readonly code: string;
  readonly txHash: string;
  readonly permanent = true;

  constructor(code: string, message: string, txHash: string) {
    super(message);
    this.name = "TxSubmissionError";
    this.code = code;
    this.txHash = txHash;
  }
}

/** Congestion — same envelope should be resubmitted shortly. */
export class TxCongestionError extends Error {
  readonly code = "TRY_AGAIN_LATER";
  readonly txHash: string;
  readonly retryAfterSeconds: number;
  readonly permanent = false;

  constructor(message: string, txHash: string, retryAfterSeconds: number) {
    super(message);
    this.name = "TxCongestionError";
    this.txHash = txHash;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type DecodedTxResultCode =
  | "txINSUFFICIENT_FEE"
  | "txBAD_SEQ"
  | "txNO_ACCOUNT"
  | "txINSUFFICIENT_BALANCE"
  | "txFAILED"
  | "txTOO_LATE"
  | "txTOO_EARLY"
  | "txMALFORMED"
  | "UNKNOWN";

export function decodeErrorResult(errorResult: unknown): { code: DecodedTxResultCode; detail: string } {
  if (!errorResult) {
    return { code: "UNKNOWN", detail: "No errorResult attached to ERROR status" };
  }

  try {
    // SDK may hand back an xdr.TransactionResult or a raw object with result()/switch().
    const result =
      typeof (errorResult as { result?: () => xdr.TransactionResultResult }).result === "function"
        ? (errorResult as xdr.TransactionResult)
        : null;

    const switchName =
      result !== null
        ? result.result().switch().name
        : typeof (errorResult as { switch?: () => { name: string } }).switch === "function"
          ? (errorResult as { switch: () => { name: string } }).switch().name
          : String((errorResult as { status?: string }).status ?? errorResult);

    const normalized = switchName.replace(/^tx/, "tx") as string;
    const known: DecodedTxResultCode[] = [
      "txINSUFFICIENT_FEE",
      "txBAD_SEQ",
      "txNO_ACCOUNT",
      "txINSUFFICIENT_BALANCE",
      "txFAILED",
      "txTOO_LATE",
      "txTOO_EARLY",
      "txMALFORMED",
    ];
    const code = (known.includes(normalized as DecodedTxResultCode)
      ? normalized
      : known.find((k) => normalized.toLowerCase().includes(k.slice(2).toLowerCase())) ?? "UNKNOWN") as DecodedTxResultCode;

    return { code, detail: `Transaction rejected: ${code}` };
  } catch (err) {
    return {
      code: "UNKNOWN",
      detail: `Failed to decode errorResult: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface SubmitOptions {
  /**
   * Remaining validity window in ms derived from the transaction's setTimeout.
   * TRY_AGAIN_LATER retries must not exceed this — past expiry is guaranteed to fail.
   * Defaults to 30s (matching TransactionBuilder.setTimeout(30) call sites).
   */
  validityWindowMs?: number;
  /** Initial backoff for TRY_AGAIN_LATER (ms). */
  initialBackoffMs?: number;
  /** Max resubmission attempts for TRY_AGAIN_LATER. */
  maxRetries?: number;
}

export interface SubmitAndConfirmResult extends ConfirmationResult {
  /** Present when the submission was rejected permanently. */
  resultCode?: DecodedTxResultCode;
  /** HTTP-ish hint for TxService mapping. */
  httpStatus?: number;
  retryAfterSeconds?: number;
}

/**
 * Shared sendTransaction status handling for TxService and ClaimSettlementService.
 *
 * Status routing:
 *  - PENDING  → poll for confirmation
 *  - DUPLICATE → already in mempool (possibly from another replica); poll, do not assume ownership
 *  - TRY_AGAIN_LATER → bounded resubmission of the SAME signed envelope (no rebuild)
 *  - ERROR → decode errorResult; never retry
 *
 * INVARIANT: the envelope passed to sendTransaction inside the TRY_AGAIN_LATER
 * retry loop is byte-identical to the original. Rebuilding would change the
 * hash / sequence and defeat safe resubmission.
 */
export async function submitAndConfirm(
  server: rpc.Server,
  signedTx: Parameters<rpc.Server["sendTransaction"]>[0],
  options: SubmitOptions = {}
): Promise<SubmitAndConfirmResult> {
  const validityWindowMs = options.validityWindowMs ?? 30_000;
  const initialBackoffMs = options.initialBackoffMs ?? 500;
  const maxRetries = options.maxRetries ?? 5;
  const deadline = Date.now() + validityWindowMs;

  // Capture the envelope XDR once so retries cannot accidentally rebuild.
  const envelopeFingerprint =
    typeof (signedTx as { toXDR?: () => string }).toXDR === "function"
      ? (signedTx as { toXDR: () => string }).toXDR()
      : null;

  let attempt = 0;
  let backoff = initialBackoffMs;
  let lastHash = "";

  for (;;) {
    if (envelopeFingerprint !== null) {
      const current =
        typeof (signedTx as { toXDR?: () => string }).toXDR === "function"
          ? (signedTx as { toXDR: () => string }).toXDR()
          : null;
      if (current !== envelopeFingerprint) {
        throw new Error(
          "INVARIANT VIOLATION: signed envelope changed during TRY_AGAIN_LATER retry — " +
            "resubmission must reuse the identical envelope (no rebuild)."
        );
      }
    }

    const sendResult = await server.sendTransaction(signedTx);
    lastHash = sendResult.hash;

    switch (sendResult.status) {
      case "PENDING":
        return await pollForConfirmation(server, sendResult.hash);

      case "DUPLICATE":
        // Benign: another replica (or a prior attempt) already has this hash
        // in the mempool. Poll for confirmation without assuming ownership.
        logger.log(`DUPLICATE for ${sendResult.hash} — treating as pending confirmation`);
        return await pollForConfirmation(server, sendResult.hash);

      case "TRY_AGAIN_LATER": {
        attempt++;
        const remaining = deadline - Date.now();
        if (attempt > maxRetries || remaining <= backoff) {
          const retryAfter = Math.max(1, Math.ceil(Math.min(backoff, Math.max(remaining, 1000)) / 1000));
          return {
            confirmed: false,
            txHash: sendResult.hash,
            error: `RPC congested (TRY_AGAIN_LATER) after ${attempt} attempt(s); retry after ${retryAfter}s`,
            httpStatus: 503,
            retryAfterSeconds: retryAfter,
          };
        }
        logger.warn(
          `TRY_AGAIN_LATER for ${sendResult.hash}; resubmitting identical envelope in ${backoff}ms ` +
            `(attempt ${attempt}/${maxRetries}, ${remaining}ms validity remaining)`
        );
        await sleep(Math.min(backoff, remaining));
        backoff = Math.min(backoff * 2, remaining);
        continue;
      }

      case "ERROR": {
        const { code, detail } = decodeErrorResult(
          (sendResult as { errorResult?: unknown }).errorResult
        );
        logger.error(`Submission ERROR for ${sendResult.hash}: ${detail}`);
        return {
          confirmed: false,
          txHash: sendResult.hash,
          error: detail,
          resultCode: code,
          httpStatus: 400,
        };
      }

      default:
        return {
          confirmed: false,
          txHash: lastHash,
          error: `Unexpected sendTransaction status: ${sendResult.status}`,
          httpStatus: 502,
        };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
