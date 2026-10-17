export interface ContributingSourceExplainItem {
  sourceId: string;
  observedAtIso: string;
  value: number;
  unit: string;
  trustTier: string;
  weight: number;
}

export interface ExcludedSourceExplainItem {
  sourceId: string;
  exclusionReason: "stale" | "outlier" | "quarantined" | "unreachable" | "warming_up";
  rawDetail?: string;
}

export interface DecisionExplainabilityInput {
  decisionId: string;
  feedId: string;
  policyVersionHash: string;
  aggregationMethod: "median" | "weighted_median";
  consensusValue: number;
  unit: string;
  triggerThresholdValue: number;
  triggerComparison: "gte" | "lte";
  requiredQuorumCount: number;
  contributingSources: ContributingSourceExplainItem[];
  excludedSources: ExcludedSourceExplainItem[];
}

export interface DecisionExplainabilityOutput {
  decisionId: string;
  triggered: boolean;
  quorumSatisfied: boolean;
  structuredRationale: {
    feedId: string;
    policyVersionHash: string;
    aggregationMethod: string;
    consensusValue: number;
    unit: string;
    triggerThresholdValue: number;
    triggerComparison: "gte" | "lte";
    quorum: { actual: number; required: number };
    contributingSources: ContributingSourceExplainItem[];
    excludedSources: ExcludedSourceExplainItem[];
  };
  proseSummary: string;
}

export class DecisionRationaleGenerator {
  public generate(input: DecisionExplainabilityInput): DecisionExplainabilityOutput {
    const quorumSatisfied = input.contributingSources.length >= input.requiredQuorumCount;
    const thresholdMet =
      input.triggerComparison === "gte"
        ? input.consensusValue >= input.triggerThresholdValue
        : input.consensusValue <= input.triggerThresholdValue;
    const triggered = quorumSatisfied && thresholdMet;

    const contribText =
      input.contributingSources.length > 0
        ? input.contributingSources
            .map((s) => `${s.sourceId} (${s.value} ${s.unit}, tier=${s.trustTier}, weight=${s.weight})`)
            .join(", ")
        : "none";

    const excludedText =
      input.excludedSources.length > 0
        ? input.excludedSources.map((e) => `${e.sourceId} (${e.exclusionReason})`).join(", ")
        : "none";

    const comparatorText = input.triggerComparison === "gte" ? ">=" : "<=";
    const outcomeText = triggered
      ? "PAYOUT TRIGGERED"
      : !quorumSatisfied
        ? "NO PAYOUT (QUORUM NOT MET)"
        : "NO PAYOUT (THRESHOLD NOT MET)";

    const proseSummary = [
      `Decision ${input.decisionId} for feed ${input.feedId}: ${outcomeText}.`,
      `Consensus ${input.aggregationMethod} value of ${input.consensusValue} ${input.unit} compared against trigger threshold (${comparatorText} ${input.triggerThresholdValue} ${input.unit}).`,
      `Quorum: ${input.contributingSources.length}/${input.requiredQuorumCount} independent sources (${contribText}).`,
      `Excluded sources: ${excludedText}.`,
      `Evaluated under quorum policy snapshot ${input.policyVersionHash}.`,
    ].join(" ");

    return {
      decisionId: input.decisionId,
      triggered,
      quorumSatisfied,
      structuredRationale: {
        feedId: input.feedId,
        policyVersionHash: input.policyVersionHash,
        aggregationMethod: input.aggregationMethod,
        consensusValue: input.consensusValue,
        unit: input.unit,
        triggerThresholdValue: input.triggerThresholdValue,
        triggerComparison: input.triggerComparison,
        quorum: {
          actual: input.contributingSources.length,
          required: input.requiredQuorumCount,
        },
        contributingSources: input.contributingSources.map((c) => ({ ...c })),
        excludedSources: input.excludedSources.map((e) => ({ ...e })),
      },
      proseSummary,
    };
  }
}
