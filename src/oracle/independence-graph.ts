/**
 * Source independence modeling for oracle corroboration (issue #206).
 *
 * Quorum must count independent origins, not configured adapters. Sources that
 * share an operator, an upstream data origin, or a hosting ASN hint are placed
 * in one independence cluster. An admin-declared cluster overrides inference
 * and is marked verified. Undeclared sources with no shared attributes default
 * to their own cluster, marked unverified, and carry half weight.
 */

export interface SourceIdentity {
  sourceId: string;
  operatorId?: string;
  upstreamOrigin?: string;
  hostingAsn?: string;
  /** Admin-declared or overridden cluster. Takes precedence over inference. */
  declaredCluster?: string;
}

export interface SourceResolution {
  sourceId: string;
  clusterId: string;
  /** 1 for verified (declared) clusters, 0.5 for inferred/unverified ones. */
  weight: number;
  verified: boolean;
}

export interface CorroborationVote {
  sourceId: string;
  clusterId: string;
  weight: number;
  value: number;
  /** Epoch milliseconds when the source observed the value. */
  observedAt?: number;
  /** Hash of the canonical payload, used to detect copied submissions. */
  payloadHash?: string;
  signature?: string;
}

export interface CorrelationFlag {
  kind: "identical_payload" | "timing_jitter";
  sourceIds: string[];
}

export interface CorroborationResult {
  /** Median of per-cluster medians. Null unless quorum is met. */
  value: number | null;
  clusterCount: number;
  /** Sum of one weight per cluster, so duplicate votes within a cluster add nothing. */
  independentWeight: number;
  quorumMet: boolean;
  reason?: "no_readings" | "insufficient_independent_clusters";
  correlated: CorrelationFlag[];
}

const VERIFIED_WEIGHT = 1;
const UNVERIFIED_WEIGHT = 0.5;
const DEFAULT_JITTER_MS = 50;

/**
 * Resolves each source to an independence cluster. Inference is a connected
 * component over shared operator, upstream origin, and hosting ASN. The result
 * does not depend on input order.
 */
export function resolveIndependence(sources: SourceIdentity[]): Map<string, SourceResolution> {
  const sorted = [...sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const parent = new Map<string, string>();

  const find = (node: string): string => {
    const p = parent.get(node);
    if (p === undefined || p === node) return node;
    const root = find(p);
    parent.set(node, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const inferred = sorted.filter((s) => s.declaredCluster === undefined);
  for (const s of inferred) {
    const node = `source:${s.sourceId}`;
    const attributes = [
      s.operatorId && `operator:${s.operatorId}`,
      s.upstreamOrigin && `origin:${s.upstreamOrigin}`,
      s.hostingAsn && `asn:${s.hostingAsn}`,
    ];
    for (const attribute of attributes) {
      if (attribute) union(node, attribute);
    }
  }

  // Sorted input makes the first source in each component its lexicographic minimum.
  const autoClusterByRoot = new Map<string, string>();
  for (const s of inferred) {
    const root = find(`source:${s.sourceId}`);
    if (!autoClusterByRoot.has(root)) autoClusterByRoot.set(root, `auto:${s.sourceId}`);
  }

  const resolutions = new Map<string, SourceResolution>();
  for (const s of sorted) {
    if (s.declaredCluster !== undefined) {
      resolutions.set(s.sourceId, {
        sourceId: s.sourceId,
        clusterId: `declared:${s.declaredCluster}`,
        weight: VERIFIED_WEIGHT,
        verified: true,
      });
    } else {
      const clusterId = autoClusterByRoot.get(find(`source:${s.sourceId}`)) ?? `auto:${s.sourceId}`;
      resolutions.set(s.sourceId, {
        sourceId: s.sourceId,
        clusterId,
        weight: UNVERIFIED_WEIGHT,
        verified: false,
      });
    }
  }
  return resolutions;
}

/**
 * Flags submissions that look copied or coordinated: identical payloads from
 * different sources, and near-simultaneous observations from different clusters.
 */
export function detectCorrelatedSubmissions(
  votes: CorroborationVote[],
  jitterMs = DEFAULT_JITTER_MS,
): CorrelationFlag[] {
  const flags: CorrelationFlag[] = [];

  const byPayload = new Map<string, CorroborationVote[]>();
  for (const v of votes) {
    if (!v.payloadHash) continue;
    const group = byPayload.get(v.payloadHash) ?? [];
    group.push(v);
    byPayload.set(v.payloadHash, group);
  }
  for (const group of byPayload.values()) {
    const sourceIds = [...new Set(group.map((v) => v.sourceId))];
    if (sourceIds.length > 1) flags.push({ kind: "identical_payload", sourceIds });
  }

  const timed = votes
    .filter((v): v is CorroborationVote & { observedAt: number } => v.observedAt !== undefined)
    .sort((a, b) => a.observedAt - b.observedAt);
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    const curr = timed[i];
    if (prev.clusterId !== curr.clusterId && curr.observedAt - prev.observedAt <= jitterMs) {
      flags.push({ kind: "timing_jitter", sourceIds: [prev.sourceId, curr.sourceId] });
    }
  }

  return flags;
}

/**
 * Corroborates votes by independence cluster. Each cluster contributes one
 * median value and one unit of weight, so a colluding cluster cannot outvote
 * an independent minority. Quorum requires at least `minClusters` independent
 * weight. The value is withheld when quorum is not met.
 */
export function corroborate(votes: CorroborationVote[], minClusters: number): CorroborationResult {
  if (!Number.isInteger(minClusters) || minClusters < 1) {
    throw new RangeError(`minClusters must be a positive integer, got ${minClusters}`);
  }

  const correlated = detectCorrelatedSubmissions(votes);
  if (votes.length === 0) {
    return { value: null, clusterCount: 0, independentWeight: 0, quorumMet: false, reason: "no_readings", correlated };
  }

  const byCluster = new Map<string, CorroborationVote[]>();
  for (const v of votes) {
    const group = byCluster.get(v.clusterId) ?? [];
    group.push(v);
    byCluster.set(v.clusterId, group);
  }

  const clusterMedians: number[] = [];
  let independentWeight = 0;
  for (const group of byCluster.values()) {
    clusterMedians.push(median(group.map((v) => v.value)));
    independentWeight += Math.max(...group.map((v) => v.weight));
  }

  const quorumMet = independentWeight >= minClusters;
  return {
    value: quorumMet ? median(clusterMedians) : null,
    clusterCount: byCluster.size,
    independentWeight,
    quorumMet,
    reason: quorumMet ? undefined : "insufficient_independent_clusters",
    correlated,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
