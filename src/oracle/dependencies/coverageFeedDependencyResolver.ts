export type FeedTrustLevel = "unavailable" | "mock_only" | "degraded_quorum" | "production_quorum";

const TRUST_RANK: Record<FeedTrustLevel, number> = {
  unavailable: 0,
  mock_only: 1,
  degraded_quorum: 2,
  production_quorum: 3,
};

export interface CoverageFeedDependency {
  coverageType: string;
  requiredFeeds: Array<{
    feedId: string;
    minTrustLevel: FeedTrustLevel;
  }>;
}

export interface CoverageAvailabilityStatus {
  coverageType: string;
  purchasable: boolean;
  status: "available" | "suspended_feed_degraded" | "suspended_unmapped_coverage";
  degradedFeeds: string[];
}

export class CoverageFeedDependencyResolver {
  private readonly mappings = new Map<string, CoverageFeedDependency>();
  private readonly feedStates = new Map<string, FeedTrustLevel>();

  public registerCoverageDependency(dep: CoverageFeedDependency): void {
    if (dep.requiredFeeds.length === 0) {
      throw new Error(`Coverage type '${dep.coverageType}' must declare at least one required feed`);
    }
    this.mappings.set(dep.coverageType, {
      coverageType: dep.coverageType,
      requiredFeeds: dep.requiredFeeds.map((f) => ({ ...f })),
    });
  }

  public updateFeedTrustLevel(feedId: string, level: FeedTrustLevel): void {
    this.feedStates.set(feedId, level);
  }

  public evaluateCoverageAvailability(coverageType: string): CoverageAvailabilityStatus {
    const dep = this.mappings.get(coverageType);
    if (!dep) {
      return {
        coverageType,
        purchasable: false,
        status: "suspended_unmapped_coverage",
        degradedFeeds: [],
      };
    }

    const degradedFeeds: string[] = [];
    for (const req of dep.requiredFeeds) {
      const actual = this.feedStates.get(req.feedId) ?? "unavailable";
      if (TRUST_RANK[actual] < TRUST_RANK[req.minTrustLevel]) {
        degradedFeeds.push(req.feedId);
      }
    }

    if (degradedFeeds.length > 0) {
      return {
        coverageType,
        purchasable: false,
        status: "suspended_feed_degraded",
        degradedFeeds,
      };
    }

    return {
      coverageType,
      purchasable: true,
      status: "available",
      degradedFeeds: [],
    };
  }

  public assertCanPurchasePolicy(coverageType: string): void {
    const status = this.evaluateCoverageAvailability(coverageType);
    if (!status.purchasable) {
      throw new Error(
        `Policy purchase rejected for '${coverageType}': ${status.status} (${status.degradedFeeds.join(", ")})`
      );
    }
  }
}
