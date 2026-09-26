import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const CONFIRMATION_POLL_INTERVAL_MS = 2000;
const CONFIRMATION_MAX_ATTEMPTS = 15; // ~30s at the interval above

export interface ConfirmationResult {
  confirmed: boolean;
  txHash: string;
  error?: string;
  /**
   * Decoded Soroban return value when the RPC provider includes it on SUCCESS.
   * Absent when the provider omits returnValue — callers must treat that as
   * "unknown", not zero.
   */
  returnValue?: xdr.ScVal;
}

export interface GetTransactionClient {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

/**
 * Polls a submitted Soroban transaction until it lands SUCCESS/FAILED or
 * polling is exhausted. Shared by every path that submits a transaction and
 * needs to know whether it actually landed on-chain (ClaimSettlementService's
 * relayer-signed process_claim call, and TxService's client-signed submits).
 */
export async function pollForConfirmation(
  server: GetTransactionClient,
  hash: string
): Promise<ConfirmationResult> {
  for (let attempt = 0; attempt < CONFIRMATION_MAX_ATTEMPTS; attempt++) {
    const result = await server.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const success = result as rpc.Api.GetSuccessfulTransactionResponse;
      return {
        confirmed: true,
        txHash: hash,
        returnValue: success.returnValue,
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { confirmed: false, txHash: hash, error: "Transaction failed on-chain" };
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_INTERVAL_MS));
  }
  return { confirmed: false, txHash: hash, error: "Timed out waiting for confirmation" };
}

/**
 * Decodes a Soroban i128 return value to bigint. Returns null when the
 * return value is missing (unknown payout) rather than coercing to 0n.
 */
export function decodeI128ReturnValue(returnValue: xdr.ScVal | undefined): bigint | null {
  if (returnValue === undefined || returnValue === null) {
    return null;
  }
  const native = scValToNative(returnValue);
  if (typeof native === "bigint") return native;
  if (typeof native === "number") return BigInt(native);
  if (typeof native === "string" && /^-?\d+$/.test(native)) return BigInt(native);
  // Result::Err from the contract surfaces as a structured object — not an i128.
  if (native && typeof native === "object") {
    throw new Error(`Contract returned an error result: ${JSON.stringify(native)}`);
  }
  throw new Error(`Unexpected Soroban return value type: ${typeof native}`);
}
