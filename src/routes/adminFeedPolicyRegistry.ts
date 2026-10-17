export type FeedTrustMode =
  | "centralized_relayer"
  | "corroborated_multi_source"
  | "decentralized_quorum";

export interface FeedSourceWeightConfig {
  sourceId: string;
  weight: number;
  enabled: boolean;
}

export interface OracleFeedPolicyDefinition {
  coverageType: string;
  sources: FeedSourceWeightConfig[];
  quorumThresholdWeight: number;
  minDistinctSources: number;
  freshnessWindowMs: number;
  trustMode: FeedTrustMode;
  enabled: boolean;
  version: number;
  updatedAtMs: number;
  updatedByActor: string;
}

export interface FeedPolicyAuditEntry {
  coverageType: string;
  version: number;
  actorId: string;
  changedAtMs: number;
  reason: string;
  before: OracleFeedPolicyDefinition | null;
  after: OracleFeedPolicyDefinition;
}

export interface AdminFeedMutationResult {
  httpStatus: 200 | 201 | 401 | 409 | 422;
  ok: boolean;
  errorCode:
    | null
    | "UNAUTHORIZED_OPERATOR"
    | "UNSATISFIABLE_QUORUM_POLICY"
    | "VERSION_CONFLICT";
  policy: OracleFeedPolicyDefinition | null;
}

export class AdminFeedPolicyRegistry {
  private readonly authorizedOperators: Set<string>;
  private readonly currentPolicies = new Map<
    string,
    OracleFeedPolicyDefinition
  >();
  private readonly auditHistory = new Map<string, FeedPolicyAuditEntry[]>();
  private readonly listeners: Array<
    (policy: OracleFeedPolicyDefinition) => void
  > = [];

  constructor(options: {
    authorizedOperators: string[];
    onPolicyChanged?: (policy: OracleFeedPolicyDefinition) => void;
  }) {
    this.authorizedOperators = new Set(options.authorizedOperators);
    if (options.onPolicyChanged) {
      this.listeners.push(options.onPolicyChanged);
    }
  }

  public upsertFeedPolicy(params: {
    actorId: string;
    reason: string;
    expectedVersion?: number;
    coverageType: string;
    sources: FeedSourceWeightConfig[];
    quorumThresholdWeight: number;
    minDistinctSources: number;
    freshnessWindowMs: number;
    trustMode: FeedTrustMode;
    enabled: boolean;
    nowMs?: number;
  }): AdminFeedMutationResult {
    const nowMs = params.nowMs ?? Date.now();

    if (
      !params.actorId ||
      !this.authorizedOperators.has(params.actorId.trim())
    ) {
      return {
        httpStatus: 401,
        ok: false,
        errorCode: "UNAUTHORIZED_OPERATOR",
        policy: null,
      };
    }

    const existing = this.currentPolicies.get(params.coverageType) ?? null;
    if (existing) {
      if (
        params.expectedVersion === undefined ||
        params.expectedVersion !== existing.version
      ) {
        return {
          httpStatus: 409,
          ok: false,
          errorCode: "VERSION_CONFLICT",
          policy: existing,
        };
      }
    } else if (
      params.expectedVersion !== undefined &&
      params.expectedVersion !== 0
    ) {
      return {
        httpStatus: 409,
        ok: false,
        errorCode: "VERSION_CONFLICT",
        policy: null,
      };
    }

    // Validate quorum satisfiability if the feed is enabled
    if (
      params.freshnessWindowMs <= 0 ||
      params.minDistinctSources < 1 ||
      params.quorumThresholdWeight <= 0
    ) {
      return {
        httpStatus: 422,
        ok: false,
        errorCode: "UNSATISFIABLE_QUORUM_POLICY",
        policy: null,
      };
    }

    const activeSources = params.sources.filter(
      (s) => s.enabled && s.weight > 0
    );
    const totalActiveWeight = activeSources.reduce(
      (sum, s) => sum + s.weight,
      0
    );

    if (params.enabled) {
      if (
        activeSources.length < params.minDistinctSources ||
        totalActiveWeight < params.quorumThresholdWeight
      ) {
        return {
          httpStatus: 422,
          ok: false,
          errorCode: "UNSATISFIABLE_QUORUM_POLICY",
          policy: null,
        };
      }
    }

    const nextVersion = existing ? existing.version + 1 : 1;
    const nextPolicy: OracleFeedPolicyDefinition = {
      coverageType: params.coverageType,
      sources: params.sources.map((s) => ({ ...s })),
      quorumThresholdWeight: params.quorumThresholdWeight,
      minDistinctSources: params.minDistinctSources,
      freshnessWindowMs: params.freshnessWindowMs,
      trustMode: params.trustMode,
      enabled: params.enabled,
      version: nextVersion,
      updatedAtMs: nowMs,
      updatedByActor: params.actorId,
    };

    this.currentPolicies.set(params.coverageType, nextPolicy);
    const history = this.auditHistory.get(params.coverageType) ?? [];
    history.push({
      coverageType: params.coverageType,
      version: nextVersion,
      actorId: params.actorId,
      changedAtMs: nowMs,
      reason: params.reason,
      before: existing,
      after: nextPolicy,
    });
    this.auditHistory.set(params.coverageType, history);

    for (const listener of this.listeners) {
      listener(nextPolicy);
    }

    return {
      httpStatus: existing ? 200 : 201,
      ok: true,
      errorCode: null,
      policy: nextPolicy,
    };
  }

  public getCurrentPolicy(
    coverageType: string
  ): OracleFeedPolicyDefinition | null {
    return this.currentPolicies.get(coverageType) ?? null;
  }

  public getVersionHistory(coverageType: string): FeedPolicyAuditEntry[] {
    return [...(this.auditHistory.get(coverageType) ?? [])];
  }

  /**
   * Returns the exact feed policy version that was in force at `timestampMs`
   * so historical consensus decisions can be audited against contemporaneous rules.
   */
  public getPolicyAtTimestamp(
    coverageType: string,
    timestampMs: number
  ): OracleFeedPolicyDefinition | null {
    const history = this.auditHistory.get(coverageType) ?? [];
    let active: OracleFeedPolicyDefinition | null = null;
    for (const entry of history) {
      if (entry.changedAtMs <= timestampMs) {
        active = entry.after;
      } else {
        break;
      }
    }
    return active;
  }
}
