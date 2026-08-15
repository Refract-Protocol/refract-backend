import { rpc } from "@stellar/stellar-sdk";

const CONFIRMATION_POLL_INTERVAL_MS = 2000;
const CONFIRMATION_MAX_ATTEMPTS = 15; // ~30s at the interval above

export interface ConfirmationResult {
  confirmed: boolean;
  txHash: string;
  error?: string;
}

/**
 * Polls a submitted Soroban transaction until it lands SUCCESS/FAILED or
 * polling is exhausted. Shared by every path that submits a transaction and
 * needs to know whether it actually landed on-chain (ClaimSettlementService's
 * relayer-signed process_claim call, and TxService's client-signed submits).
 */
export async function pollForConfirmation(server: rpc.Server, hash: string): Promise<ConfirmationResult> {
  for (let attempt = 0; attempt < CONFIRMATION_MAX_ATTEMPTS; attempt++) {
    const result = await server.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { confirmed: true, txHash: hash };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { confirmed: false, txHash: hash, error: "Transaction failed on-chain" };
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_INTERVAL_MS));
  }
  return { confirmed: false, txHash: hash, error: "Timed out waiting for confirmation" };
}
