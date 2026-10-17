export interface FeedLatencyBudgetConfig {
  feedId: string;
  sourceFetchTimeoutMs: number;
  observationToDecisionBudgetMs: number;
  decisionToPublishBudgetMs: number;
  totalEndToEndBudgetMs: number;
}

export interface SourceFetchAttempt {
  sourceId: string;
  value: number;
  durationMs: number;
}

export interface LatencyBudgetDecisionEvaluation {
  feedId: string;
  timelySources: SourceFetchAttempt[];
  lateSourceIds: string[];
  observationToDecisionMs: number;
  decisionToPublishMs: number;
  totalEndToEndMs: number;
  publishAllowed: boolean;
  abortReason:
    | "none"
    | "observation_to_decision_budget_exceeded"
    | "decision_to_publish_budget_exceeded"
    | "end_to_end_deadline_exceeded";
}

export class ConsensusLatencyBudgetEnforcer {
  private readonly budgets = new Map<string, FeedLatencyBudgetConfig>();

  public registerBudget(config: FeedLatencyBudgetConfig): void {
    this.budgets.set(config.feedId, { ...config });
  }

  public evaluateRound(params: {
    feedId: string;
    earliestObservationAtMs: number;
    decisionComputedAtMs: number;
    publishAttemptAtMs: number;
    sourceAttempts: SourceFetchAttempt[];
  }): LatencyBudgetDecisionEvaluation {
    const budget = this.budgets.get(params.feedId);
    if (!budget) {
      throw new Error(`No latency budget configured for feed '${params.feedId}'`);
    }

    const timelySources: SourceFetchAttempt[] = [];
    const lateSourceIds: string[] = [];

    for (const attempt of params.sourceAttempts) {
      if (attempt.durationMs <= budget.sourceFetchTimeoutMs) {
        timelySources.push(attempt);
      } else {
        lateSourceIds.push(attempt.sourceId);
      }
    }

    const observationToDecisionMs = params.decisionComputedAtMs - params.earliestObservationAtMs;
    const decisionToPublishMs = params.publishAttemptAtMs - params.decisionComputedAtMs;
    const totalEndToEndMs = params.publishAttemptAtMs - params.earliestObservationAtMs;

    let abortReason: LatencyBudgetDecisionEvaluation["abortReason"] = "none";
    if (observationToDecisionMs > budget.observationToDecisionBudgetMs) {
      abortReason = "observation_to_decision_budget_exceeded";
    } else if (decisionToPublishMs > budget.decisionToPublishBudgetMs) {
      abortReason = "decision_to_publish_budget_exceeded";
    } else if (totalEndToEndMs > budget.totalEndToEndBudgetMs) {
      abortReason = "end_to_end_deadline_exceeded";
    }

    return {
      feedId: params.feedId,
      timelySources,
      lateSourceIds,
      observationToDecisionMs,
      decisionToPublishMs,
      totalEndToEndMs,
      publishAllowed: abortReason === "none",
      abortReason,
    };
  }
}
