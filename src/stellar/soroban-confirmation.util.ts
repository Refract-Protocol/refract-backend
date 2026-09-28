import { rpc } from "@stellar/stellar-sdk";

const CONFIRMATION_POLL_INTERVAL_MS = 2000;
const CONFIRMATION_MAX_ATTEMPTS = 15; // ~30s at the interval above

export interface ConfirmationResult {
  confirmed: boolean;
  txHash: string;
  error?: string;
}

/**
 * Polls a submitted Soroban transaction until the RPC reports a finalized
 * ledger result. Soroban RPC only returns SUCCESS/FAILED from getTransaction
 * after the transaction is included in a closed ledger; checking both ledger
 * fields prevents a partially populated response from being mistaken for
 * finality.
 */
export async function pollForConfirmation(server: rpc.Server, hash: string): Promise<ConfirmationResult> {
  for (let attempt = 0; attempt < CONFIRMATION_MAX_ATTEMPTS; attempt++) {
    const result = await server.getTransaction(hash);
    if (
      result.status === rpc.Api.GetTransactionStatus.SUCCESS &&
      result.ledger !== undefined &&
      result.latestLedger !== undefined &&
      result.latestLedger >= result.ledger
    ) {
      return { confirmed: true, txHash: hash };
    }
    if (
      result.status === rpc.Api.GetTransactionStatus.FAILED &&
      result.ledger !== undefined &&
      result.latestLedger !== undefined &&
      result.latestLedger >= result.ledger
    ) {
      return { confirmed: false, txHash: hash, error: "Transaction failed on-chain" };
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_INTERVAL_MS));
  }
  return { confirmed: false, txHash: hash, error: "Timed out waiting for confirmation" };
}
