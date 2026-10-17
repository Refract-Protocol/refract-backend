export interface SourceIndependenceMetadata {
  sourceId: string;
  operatorId: string;
  upstreamOrigin: string;
  asnHint?: string;
  declaredClusterId?: string;
}

export interface ClusterOverrideAuditRecord {
  overrideId: string;
  sourceId: string;
  previousClusterId: string;
  newClusterId: string;
  actorId: string;
  reason: string;
  appliedAtMs: number;
  revertedAtMs?: number;
}

export interface ClusterCandidateReading {
  sourceId: string;
  value: number;
  observedAtMs: number;
  receivedAtMs: number;
  rawPayloadHash?: string;
}

export interface CorrelationAlert {
  type: "identical_payload_across_clusters" | "near_zero_jitter_sync";
  sourceIds: string[];
  clusterIds: string[];
  detail: string;
}

export interface ClusterCorroborationResult {
  status: "corroborated" | "quorum_unsatisfiable" | "insufficient_independent_clusters" | "divergent";
  agreedValue: number | null;
  totalSources: number;
  independentClusterCount: number;
  agreeingClusterIds: string[];
  clusterMedians: Record<string, number>;
  correlationAlerts: CorrelationAlert[];
  unverifiedSources: string[];
}

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export class IndependenceGraph {
  private readonly sources = new Map<string, SourceIndependenceMetadata>();
  private readonly adminOverrides = new Map<string, string>();
  private readonly auditLog: ClusterOverrideAuditRecord[] = [];
  private seq = 0;

  public registerSource(meta: SourceIndependenceMetadata): void {
    this.sources.set(meta.sourceId, {
      ...meta,
      operatorId: meta.operatorId.trim().toLowerCase(),
      upstreamOrigin: meta.upstreamOrigin.trim().toLowerCase(),
    });
  }

  public overrideSourceCluster(params: {
    sourceId: string;
    newClusterId: string;
    actorId: string;
    reason: string;
    nowMs?: number;
  }): ClusterOverrideAuditRecord {
    const previousClusterId = this.resolveClusterId(params.sourceId).clusterId;
    this.adminOverrides.set(params.sourceId, params.newClusterId);
    this.seq += 1;
    const record: ClusterOverrideAuditRecord = {
      overrideId: `ovr-${this.seq}`,
      sourceId: params.sourceId,
      previousClusterId,
      newClusterId: params.newClusterId,
      actorId: params.actorId,
      reason: params.reason,
      appliedAtMs: params.nowMs ?? Date.now(),
    };
    this.auditLog.push(record);
    return { ...record };
  }

  public revertClusterOverride(
    sourceId: string,
    nowMs: number = Date.now()
  ): boolean {
    if (!this.adminOverrides.has(sourceId)) {
      return false;
    }
    this.adminOverrides.delete(sourceId);
    for (let i = this.auditLog.length - 1; i >= 0; i--) {
      const entry = this.auditLog[i]!;
      if (entry.sourceId === sourceId && entry.revertedAtMs === undefined) {
        entry.revertedAtMs = nowMs;
        break;
      }
    }
    return true;
  }

  public getAuditLog(): ClusterOverrideAuditRecord[] {
    return this.auditLog.map((r) => ({ ...r }));
  }

  public resolveClusterId(sourceId: string): {
    clusterId: string;
    verified: boolean;
  } {
    const override = this.adminOverrides.get(sourceId);
    if (override) {
      return { clusterId: override, verified: true };
    }

    const meta = this.sources.get(sourceId);
    if (!meta) {
      return { clusterId: `unverified:${sourceId}`, verified: false };
    }

    if (meta.declaredClusterId) {
      return { clusterId: `cluster:${meta.declaredClusterId}`, verified: true };
    }

    // Group transitively by shared upstreamOrigin or shared operatorId
    for (const other of this.sources.values()) {
      if (
        other.upstreamOrigin === meta.upstreamOrigin ||
        other.operatorId === meta.operatorId
      ) {
        if (other.declaredClusterId) {
          return {
            clusterId: `cluster:${other.declaredClusterId}`,
            verified: true,
          };
        }
      }
    }

    return {
      clusterId: `origin:${meta.upstreamOrigin}|op:${meta.operatorId}`,
      verified: true,
    };
  }

  public evaluateClusterCorroboration(
    readings: Array<{
      sourceId: string;
      value: number;
      observedAtMs: number;
      receivedAtMs: number;
      rawPayloadHash?: string;
    }>,
    options: {
      minIndependentClusters: number;
      toleranceBandRatio: number;
      maxCorrelationJitterMs?: number;
    }
  ): ClusterCorroborationResult {
    const maxJitterMs = options.maxCorrelationJitterMs ?? 15;
    const unverifiedSources: string[] = [];
    const correlationAlerts: CorrelationAlert[] = [];

    // Resolve initial clusters
    const resolvedBySource = new Map<string, string>();
    for (const r of readings) {
      const res = this.resolveClusterId(r.sourceId);
      if (!res.verified) {
        unverifiedSources.push(r.sourceId);
      }
      resolvedBySource.set(r.sourceId, res.clusterId);
    }

    // Detect correlated payloads across distinct declared clusters and collapse them
    for (let i = 0; i < readings.length; i++) {
      for (let j = i + 1; j < readings.length; j++) {
        const a = readings[i]!;
        const b = readings[j]!;
        const clusterA = resolvedBySource.get(a.sourceId)!;
        const clusterB = resolvedBySource.get(b.sourceId)!;
        if (clusterA === clusterB) continue;

        if (
          a.rawPayloadHash &&
          b.rawPayloadHash &&
          a.rawPayloadHash === b.rawPayloadHash
        ) {
          correlationAlerts.push({
            type: "identical_payload_across_clusters",
            sourceIds: [a.sourceId, b.sourceId],
            clusterIds: [clusterA, clusterB],
            detail: `Identical payload hash ${a.rawPayloadHash} across distinct clusters`,
          });
          // Collapse B into A's cluster so they cannot count as two independent votes
          resolvedBySource.set(b.sourceId, clusterA);
        } else if (
          Math.abs(a.receivedAtMs - b.receivedAtMs) <= maxJitterMs &&
          a.value === b.value
        ) {
          correlationAlerts.push({
            type: "near_zero_jitter_sync",
            sourceIds: [a.sourceId, b.sourceId],
            clusterIds: [clusterA, clusterB],
            detail: `Near-zero arrival jitter (${Math.abs(a.receivedAtMs - b.receivedAtMs)}ms) with identical value`,
          });
        }
      }
    }

    // Group readings by effective independent cluster
    const valuesByCluster = new Map<string, number[]>();
    for (const r of readings) {
      const cid = resolvedBySource.get(r.sourceId)!;
      const list = valuesByCluster.get(cid) ?? [];
      list.push(r.value);
      valuesByCluster.set(cid, list);
    }

    const independentClusterCount = valuesByCluster.size;
    const clusterMedians: Record<string, number> = {};
    for (const [cid, vals] of valuesByCluster.entries()) {
      clusterMedians[cid] = computeMedian(vals);
    }

    if (independentClusterCount < options.minIndependentClusters) {
      return {
        status:
          independentClusterCount <= 1
            ? "quorum_unsatisfiable"
            : "insufficient_independent_clusters",
        agreedValue: null,
        totalSources: readings.length,
        independentClusterCount,
        agreeingClusterIds: [],
        clusterMedians,
        correlationAlerts,
        unverifiedSources,
      };
    }

    // Each independent cluster gets 1 equal vote via its cluster median
    const clusterEntries = Object.entries(clusterMedians);
    const candidateOverallMedian = computeMedian(
      clusterEntries.map(([, v]) => v)
    );
    const denom = Math.max(Math.abs(candidateOverallMedian), 1e-9);

    const agreeingClusters: Array<[string, number]> = [];
    for (const [cid, val] of clusterEntries) {
      if (
        Math.abs(val - candidateOverallMedian) / denom <=
        options.toleranceBandRatio + 1e-12
      ) {
        agreeingClusters.push([cid, val]);
      }
    }

    if (agreeingClusters.length < options.minIndependentClusters) {
      return {
        status: "divergent",
        agreedValue: null,
        totalSources: readings.length,
        independentClusterCount,
        agreeingClusterIds: agreeingClusters.map(([cid]) => cid),
        clusterMedians,
        correlationAlerts,
        unverifiedSources,
      };
    }

    const agreedValue = computeMedian(agreeingClusters.map(([, val]) => val));

    return {
      status: "corroborated",
      agreedValue,
      totalSources: readings.length,
      independentClusterCount,
      agreeingClusterIds: agreeingClusters.map(([cid]) => cid),
      clusterMedians,
      correlationAlerts,
      unverifiedSources,
    };
  }
}
