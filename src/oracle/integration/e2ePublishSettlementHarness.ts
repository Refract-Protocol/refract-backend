export interface ActivePolicyFixture {
  policyId: string;
  coverageType: string;
  triggerThreshold: number;
  payoutAmountStroops: bigint;
  settled: boolean;
}

export interface SorobanPoolEventRecord {
  eventId: string;
  policyId: string;
  txHash: string;
  eventType: "claim_settled" | "settlement_failed";
  payoutAmountStroops: bigint;
  reason?: string;
}

export class E2EPublishSettlementHarness {
  private poolBalanceStroops: bigint;
  private contractRejectMode = false;
  private readonly policies = new Map<string, ActivePolicyFixture>();
  private readonly onChainOracleReadings = new Map<string, { value: number; txHash: string }>();
  private readonly poolEvents: SorobanPoolEventRecord[] = [];
  private txCounter = 0;

  constructor(initialPoolBalanceStroops: bigint) {
    this.poolBalanceStroops = initialPoolBalanceStroops;
  }

  public setContractRejectMode(reject: boolean): void {
    this.contractRejectMode = reject;
  }

  public registerPolicy(policy: ActivePolicyFixture): void {
    this.policies.set(policy.policyId, { ...policy });
  }

  public runFullPipeline(params: {
    coverageType: string;
    ingestedSourceValues: number[];
    minQuorum: number;
  }): {
    consensusReached: boolean;
    medianValue: number | null;
    oraclePublishTxHash: string | null;
    settledPolicyIds: string[];
    failedPolicyIds: string[];
    poolEvents: SorobanPoolEventRecord[];
  } {
    if (params.ingestedSourceValues.length < params.minQuorum) {
      return {
        consensusReached: false,
        medianValue: null,
        oraclePublishTxHash: null,
        settledPolicyIds: [],
        failedPolicyIds: [],
        poolEvents: [...this.poolEvents],
      };
    }

    const sorted = [...params.ingestedSourceValues].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianValue =
      sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    if (this.contractRejectMode) {
      throw new Error("Soroban RPC simulation/submission rejected by RefractOracle contract");
    }

    const oraclePublishTxHash = `tx-oracle-${++this.txCounter}`;
    this.onChainOracleReadings.set(params.coverageType, {
      value: medianValue,
      txHash: oraclePublishTxHash,
    });

    const settledPolicyIds: string[] = [];
    const failedPolicyIds: string[] = [];

    for (const policy of this.policies.values()) {
      if (policy.coverageType !== params.coverageType) continue;
      if (policy.settled) continue; // Idempotency guard: never settle twice
      if (medianValue < policy.triggerThreshold) continue;

      if (this.poolBalanceStroops < policy.payoutAmountStroops) {
        failedPolicyIds.push(policy.policyId);
        this.poolEvents.push({
          eventId: `evt-${this.poolEvents.length + 1}`,
          policyId: policy.policyId,
          txHash: `tx-settle-fail-${++this.txCounter}`,
          eventType: "settlement_failed",
          payoutAmountStroops: 0n,
          reason: "insufficient_pool_balance",
        });
        continue;
      }

      this.poolBalanceStroops -= policy.payoutAmountStroops;
      policy.settled = true;
      settledPolicyIds.push(policy.policyId);
      this.poolEvents.push({
        eventId: `evt-${this.poolEvents.length + 1}`,
        policyId: policy.policyId,
        txHash: `tx-settle-ok-${++this.txCounter}`,
        eventType: "claim_settled",
        payoutAmountStroops: policy.payoutAmountStroops,
      });
    }

    return {
      consensusReached: true,
      medianValue,
      oraclePublishTxHash,
      settledPolicyIds,
      failedPolicyIds,
      poolEvents: [...this.poolEvents],
    };
  }
}
