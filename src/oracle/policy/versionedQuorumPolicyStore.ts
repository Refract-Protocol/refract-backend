import { createHash } from "node:crypto";

export interface QuorumPolicyParameters {
  feedId: string;
  minIndependentSources: number;
  maxRelativeSpreadBps: number;
  outlierDeviationMultiplier: number;
  freshnessWindowMs: number;
  aggregationMethod: "median" | "weighted_median";
  trustMode: "development" | "testnet" | "production";
  sourceWeights: Record<string, number>;
}

export interface QuorumPolicySnapshotRecord {
  policyHash: string;
  parameters: QuorumPolicyParameters;
  createdAtMs: number;
}

export interface DecisionPolicyReference {
  decisionId: string;
  policyHash: string | "unversioned";
  snapshot: QuorumPolicySnapshotRecord | null;
}

export class VersionedQuorumPolicyStore {
  private readonly snapshots = new Map<string, QuorumPolicySnapshotRecord>();
  private readonly decisionRefs = new Map<string, string | null>();

  public computePolicyHash(params: QuorumPolicyParameters): string {
    const sortedWeights = Object.keys(params.sourceWeights)
      .sort()
      .reduce<Record<string, number>>((acc, k) => {
        acc[k] = params.sourceWeights[k];
        return acc;
      }, {});

    const canonical = JSON.stringify({
      aggregationMethod: params.aggregationMethod,
      feedId: params.feedId,
      freshnessWindowMs: params.freshnessWindowMs,
      maxRelativeSpreadBps: params.maxRelativeSpreadBps,
      minIndependentSources: params.minIndependentSources,
      outlierDeviationMultiplier: params.outlierDeviationMultiplier,
      sourceWeights: sortedWeights,
      trustMode: params.trustMode,
    });

    return createHash("sha256").update(canonical).digest("hex");
  }

  public getOrCreateSnapshot(
    params: QuorumPolicyParameters,
    nowMs: number
  ): QuorumPolicySnapshotRecord {
    const policyHash = this.computePolicyHash(params);
    const existing = this.snapshots.get(policyHash);
    if (existing) {
      return existing;
    }

    const record: QuorumPolicySnapshotRecord = {
      policyHash,
      parameters: {
        ...params,
        sourceWeights: { ...params.sourceWeights },
      },
      createdAtMs: nowMs,
    };
    this.snapshots.set(policyHash, record);
    return record;
  }

  public linkDecisionToPolicy(decisionId: string, policyHash: string | null): void {
    if (policyHash !== null && !this.snapshots.has(policyHash)) {
      throw new Error(`Cannot link decision '${decisionId}' to unknown policy hash '${policyHash}'`);
    }
    this.decisionRefs.set(decisionId, policyHash);
  }

  public resolveDecisionPolicy(decisionId: string): DecisionPolicyReference {
    const hash = this.decisionRefs.get(decisionId) ?? null;
    if (!hash) {
      return {
        decisionId,
        policyHash: "unversioned",
        snapshot: null,
      };
    }

    return {
      decisionId,
      policyHash: hash,
      snapshot: this.snapshots.get(hash) ?? null,
    };
  }

  public getSnapshotCount(): number {
    return this.snapshots.size;
  }
}
