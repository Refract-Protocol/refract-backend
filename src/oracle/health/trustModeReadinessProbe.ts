export type OracleTrustMode = "development" | "testnet" | "production";

export interface FeedSourceHealthSummary {
  feedId: string;
  requiredQuorum: number;
  healthyRealSourceCount: number;
  healthyMockSourceCount: number;
}

export interface ReadinessEvaluationInput {
  trustMode: OracleTrustMode;
  databaseConnected: boolean;
  redisConnected: boolean;
  sorobanRpcReachable: boolean;
  feeds: FeedSourceHealthSummary[];
}

export interface ReadinessProbeResponse {
  httpStatus: 200 | 503;
  ready: boolean;
  trustMode: OracleTrustMode;
  failingChecks: string[];
}

export class TrustModeReadinessProbe {
  public checkLiveness(): { httpStatus: 200; status: "alive" } {
    return { httpStatus: 200, status: "alive" };
  }

  public checkReadiness(input: ReadinessEvaluationInput): ReadinessProbeResponse {
    const failingChecks: string[] = [];

    if (!input.databaseConnected) failingChecks.push("database_unreachable");
    if (!input.redisConnected) failingChecks.push("redis_unreachable");
    if (!input.sorobanRpcReachable) failingChecks.push("soroban_rpc_unreachable");

    for (const feed of input.feeds) {
      if (input.trustMode === "production") {
        if (feed.healthyMockSourceCount > 0) {
          failingChecks.push(`feed_${feed.feedId}_mock_sources_forbidden_in_production`);
        }
        if (feed.healthyRealSourceCount < feed.requiredQuorum) {
          failingChecks.push(`feed_${feed.feedId}_insufficient_real_quorum`);
        }
      } else if (input.trustMode === "testnet") {
        if (feed.healthyRealSourceCount < feed.requiredQuorum) {
          failingChecks.push(`feed_${feed.feedId}_insufficient_real_quorum`);
        }
      } else {
        const total = feed.healthyRealSourceCount + feed.healthyMockSourceCount;
        if (total < 1) {
          failingChecks.push(`feed_${feed.feedId}_no_sources_available`);
        }
      }
    }

    const ready = failingChecks.length === 0;
    return {
      httpStatus: ready ? 200 : 503,
      ready,
      trustMode: input.trustMode,
      failingChecks,
    };
  }
}
