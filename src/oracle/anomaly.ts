export interface AnomalyRuleConfig {
  coverageType: string;
  maxStepDeltaRatio: number;
  maxDispersionRatio: number;
  maxConsecutiveQuorumFailures: number;
  minPlausibleValue: number;
  maxPlausibleValue: number;
}

export interface AnomalyCheckInput {
  coverageType: string;
  currentValue?: number | null;
  previousValue?: number | null;
  dispersionRatio?: number;
  consecutiveQuorumFailures?: number;
}

export type AnomalyViolationCode =
  | "VALUE_OUT_OF_PLAUSIBLE_RANGE"
  | "STEP_DELTA_SPIKE"
  | "SOURCE_DISPERSION_SPIKE"
  | "CONSECUTIVE_QUORUM_FAILURES"
  | "RULE_EVALUATION_ERROR";

export interface AnomalyEvaluationResult {
  anomalous: boolean;
  violations: AnomalyViolationCode[];
  details: string[];
}

export function evaluateFeedAnomaly(
  input: AnomalyCheckInput,
  config: AnomalyRuleConfig
): AnomalyEvaluationResult {
  try {
    const violations: AnomalyViolationCode[] = [];
    const details: string[] = [];

    if (
      !config ||
      !Number.isFinite(config.maxStepDeltaRatio) ||
      !Number.isFinite(config.maxDispersionRatio)
    ) {
      return {
        anomalous: true,
        violations: ["RULE_EVALUATION_ERROR"],
        details: ["Invalid anomaly rule configuration (fail-closed)"],
      };
    }

    const quorumFailures = input.consecutiveQuorumFailures ?? 0;
    if (quorumFailures >= config.maxConsecutiveQuorumFailures) {
      violations.push("CONSECUTIVE_QUORUM_FAILURES");
      details.push(
        `Consecutive quorum failures (${quorumFailures}) >= limit (${config.maxConsecutiveQuorumFailures})`
      );
    }

    if (input.currentValue !== undefined && input.currentValue !== null) {
      if (!Number.isFinite(input.currentValue)) {
        violations.push("RULE_EVALUATION_ERROR");
        details.push("Non-finite current reading value");
      } else {
        if (
          input.currentValue < config.minPlausibleValue ||
          input.currentValue > config.maxPlausibleValue
        ) {
          violations.push("VALUE_OUT_OF_PLAUSIBLE_RANGE");
          details.push(
            `Value ${input.currentValue} outside [${config.minPlausibleValue}, ${config.maxPlausibleValue}]`
          );
        }

        if (
          input.previousValue !== undefined &&
          input.previousValue !== null &&
          Number.isFinite(input.previousValue)
        ) {
          const denom = Math.max(Math.abs(input.previousValue), 1e-9);
          const stepDeltaRatio =
            Math.abs(input.currentValue - input.previousValue) / denom;
          if (stepDeltaRatio > config.maxStepDeltaRatio) {
            violations.push("STEP_DELTA_SPIKE");
            details.push(
              `Step delta ratio ${stepDeltaRatio.toFixed(4)} > max ${config.maxStepDeltaRatio}`
            );
          }
        }
      }
    }

    if (
      input.dispersionRatio !== undefined &&
      input.dispersionRatio > config.maxDispersionRatio
    ) {
      violations.push("SOURCE_DISPERSION_SPIKE");
      details.push(
        `Source dispersion ratio ${input.dispersionRatio.toFixed(4)} > max ${config.maxDispersionRatio}`
      );
    }

    return {
      anomalous: violations.length > 0,
      violations,
      details,
    };
  } catch (err) {
    // Fail-closed: any unexpected error during anomaly rule evaluation trips the breaker
    return {
      anomalous: true,
      violations: ["RULE_EVALUATION_ERROR"],
      details: [
        err instanceof Error ? err.message : "Unknown anomaly evaluation error",
      ],
    };
  }
}
