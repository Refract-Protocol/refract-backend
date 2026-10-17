export type PlausibilityAction = "accept" | "reject" | "quarantine";

export interface FeedPlausibilityRule {
  ruleId: string;
  feedId: string;
  field: string;
  minAllowed: number;
  maxAllowed: number;
  maxStepDelta?: number;
  allowZeroOrNegative: boolean;
  violationAction: "reject" | "quarantine";
}

export interface PlausibilityEvaluationResult {
  action: PlausibilityAction;
  violatedRuleId?: string;
  offendingField?: string;
  offendingValue?: number;
  reason?: string;
}

export class FeedPlausibilityRuleEngine {
  private readonly rulesByFeed = new Map<string, FeedPlausibilityRule[]>();
  private readonly lastValidValueBySourceFeed = new Map<string, number>();

  public registerRule(rule: FeedPlausibilityRule): void {
    if (!Number.isFinite(rule.minAllowed) || !Number.isFinite(rule.maxAllowed) || rule.minAllowed > rule.maxAllowed) {
      throw new Error(`Invalid bounds in plausibility rule '${rule.ruleId}': minAllowed (${rule.minAllowed}) > maxAllowed (${rule.maxAllowed})`);
    }
    if (rule.maxStepDelta !== undefined && rule.maxStepDelta <= 0) {
      throw new Error(`Invalid maxStepDelta in plausibility rule '${rule.ruleId}': must be > 0`);
    }
    if (!this.rulesByFeed.has(rule.feedId)) {
      this.rulesByFeed.set(rule.feedId, []);
    }
    this.rulesByFeed.get(rule.feedId)!.push({ ...rule });
  }

  public evaluateReading(params: {
    sourceId: string;
    feedId: string;
    fields: Record<string, number>;
  }): PlausibilityEvaluationResult {
    const rules = this.rulesByFeed.get(params.feedId) ?? [];

    for (const rule of rules) {
      const val = params.fields[rule.field];
      if (val === undefined || !Number.isFinite(val)) {
        return {
          action: rule.violationAction,
          violatedRuleId: rule.ruleId,
          offendingField: rule.field,
          offendingValue: val,
          reason: "missing_or_non_finite_value",
        };
      }

      if (!rule.allowZeroOrNegative && val <= 0) {
        return {
          action: rule.violationAction,
          violatedRuleId: rule.ruleId,
          offendingField: rule.field,
          offendingValue: val,
          reason: "zero_or_negative_disallowed",
        };
      }

      if (val < rule.minAllowed || val > rule.maxAllowed) {
        return {
          action: rule.violationAction,
          violatedRuleId: rule.ruleId,
          offendingField: rule.field,
          offendingValue: val,
          reason: "out_of_bounds",
        };
      }

      const stateKey = `${params.sourceId}::${params.feedId}::${rule.field}`;
      const prev = this.lastValidValueBySourceFeed.get(stateKey);
      if (rule.maxStepDelta !== undefined && prev !== undefined) {
        if (Math.abs(val - prev) > rule.maxStepDelta) {
          return {
            action: rule.violationAction,
            violatedRuleId: rule.ruleId,
            offendingField: rule.field,
            offendingValue: val,
            reason: "max_step_delta_exceeded",
          };
        }
      }

      this.lastValidValueBySourceFeed.set(stateKey, val);
    }

    return { action: "accept" };
  }
}
