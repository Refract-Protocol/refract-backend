export interface OnChainRefractOracleEntry {
  contractId: string;
  feedId: string;
  scaledValue: bigint;
  decimals: number;
  ledgerSequence: number;
  ledgerTimestampMs: number;
  txHash: string;
  submitterAddress: string;
}

export interface CorroboratingReadingResult {
  acceptedForIndependentQuorum: boolean;
  reason: "ok" | "self_published_excluded" | "stale_ledger_entry" | "rpc_unavailable";
  normalizedValue?: number;
  provenance?: {
    contractId: string;
    ledgerSequence: number;
    txHash: string;
    submitterAddress: string;
  };
}

export class OnChainRefractOracleAdapter {
  private readonly localRelayerAddresses: Set<string>;
  private readonly maxLedgerStalenessMs: number;

  constructor(localRelayerAddresses: string[], maxLedgerStalenessMs = 300_000) {
    this.localRelayerAddresses = new Set(localRelayerAddresses);
    this.maxLedgerStalenessMs = maxLedgerStalenessMs;
  }

  public evaluateOnChainEntry(
    entry: OnChainRefractOracleEntry | null,
    nowMs: number
  ): CorroboratingReadingResult {
    if (!entry) {
      return { acceptedForIndependentQuorum: false, reason: "rpc_unavailable" };
    }

    // Anti-self-corroboration guard: never count our own relayer submissions as independent quorum
    if (this.localRelayerAddresses.has(entry.submitterAddress)) {
      return {
        acceptedForIndependentQuorum: false,
        reason: "self_published_excluded",
      };
    }

    if (nowMs - entry.ledgerTimestampMs > this.maxLedgerStalenessMs) {
      return {
        acceptedForIndependentQuorum: false,
        reason: "stale_ledger_entry",
      };
    }

    const scaleFactor = 10 ** entry.decimals;
    const normalizedValue = Number(entry.scaledValue) / scaleFactor;

    return {
      acceptedForIndependentQuorum: true,
      reason: "ok",
      normalizedValue,
      provenance: {
        contractId: entry.contractId,
        ledgerSequence: entry.ledgerSequence,
        txHash: entry.txHash,
        submitterAddress: entry.submitterAddress,
      },
    };
  }
}
