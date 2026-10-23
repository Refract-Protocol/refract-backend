/**
 * Cross-feed economic consistency evaluation (issue #280).
 *
 * Operates on canonicalized consensus values plus their timestamps using the
 * same point-in-time semantics as consensus, so replay reproduces the verdict.
 * A rule whose reference side is missing or whose timestamps fall outside the
 * allowed lead/lag window is *skipped*, never failed.
 */

import {
  ConsistencyRule,
  rulesForCoverage,
} from './rules';

/** Canonicalized consensus observation for a single feed. */
export interface ConsensusObservation {
  coverage: string;
  /** Canonicalized consensus value (already normalized by consensus). */
  value: number;
  /** Timestamp of the consensus observation (ms since epoch). */
  timestamp: number;
}

export type ConsistencyVerdict = 'coherent' | 'violation' | 'skipped';

export interface ConsistencyEvaluation {
  ruleId: string;
  dependentCoverage: string;
  referenceCoverages: string[];
  verdict: ConsistencyVerdict;
  severity: ConsistencyRule['severity'];
  /** Human-readable explanation, present on violations and skips. */
  explanation: string;
  /** Relative move of the dependent feed, when computed. */
  dependentMove?: number;
  /** Relative move of the reference feed, when computed. */
  referenceMove?: number;
}

function relativeMove(from: number, to: number): number {
  if (from === 0) return 0;
  return (to - from) / Math.abs(from);
}

function findObservation(
  observations: ConsensusObservation[],
  coverage: string,
): ConsensusObservation | undefined {
  return observations.find((obs) => obs.coverage === coverage);
}

/**
 * Evaluate a single rule against the provided consensus observations.
 * Deterministic: depends only on the observations passed in.
 */
export function evaluateRule(
  rule: ConsistencyRule,
  observations: ConsensusObservation[],
): ConsistencyEvaluation {
  const dependent = findObservation(observations, rule.dependentCoverage);
  if (!dependent) {
    return {
      ruleId: rule.id,
      dependentCoverage: rule.dependentCoverage,
      referenceCoverages: rule.referenceCoverages,
      verdict: 'skipped',
      severity: rule.severity,
      explanation: `Skipped ${rule.id}: dependent feed ${rule.dependentCoverage} has no consensus observation.`,
    };
  }

  const references = rule.referenceCoverages
    .map((coverage) => findObservation(observations, coverage))
    .filter((obs): obs is ConsensusObservation => obs !== undefined);

  if (references.length === 0) {
    return {
      ruleId: rule.id,
      dependentCoverage: rule.dependentCoverage,
      referenceCoverages: rule.referenceCoverages,
      verdict: 'skipped',
      severity: rule.severity,
      explanation: `Skipped ${rule.id}: no reference observation for ${rule.referenceCoverages.join(', ')}.`,
    };
  }

  // Differing freshness windows: skip if any reference is outside lead/lag.
  const withinWindow = references.filter(
    (ref) => Math.abs(ref.timestamp - dependent.timestamp) <= rule.maxLeadLagMs,
  );
  if (withinWindow.length === 0) {
    return {
      ruleId: rule.id,
      dependentCoverage: rule.dependentCoverage,
      referenceCoverages: rule.referenceCoverages,
      verdict: 'skipped',
      severity: rule.severity,
      explanation: `Skipped ${rule.id}: reference observations fall outside the allowed lead/lag window of ${rule.maxLeadLagMs}ms.`,
    };
  }

  // Use the most recent in-window reference for the move comparison.
  const reference = withinWindow.reduce((latest, ref) =>
    ref.timestamp > latest.timestamp ? ref : latest,
  );

  // Relative moves are computed against the dependent's own prior value when
  // available; here we compare the dependent's move to the reference's move
  // using the same observation set so replay is deterministic.
  const dependentMove = relativeMove(reference.value, dependent.value);
  const referenceMove = relativeMove(dependent.value, reference.value);

  const dependentTriggered = Math.abs(dependentMove) >= rule.triggerThreshold;
  if (!dependentTriggered) {
    return {
      ruleId: rule.id,
      dependentCoverage: rule.dependentCoverage,
      referenceCoverages: rule.referenceCoverages,
      verdict: 'coherent',
      severity: rule.severity,
      explanation: `Coherent ${rule.id}: dependent move ${dependentMove.toFixed(4)} below trigger threshold ${rule.triggerThreshold}.`,
      dependentMove,
      referenceMove,
    };
  }

  const referenceJustifies = Math.abs(referenceMove) >= rule.referenceThreshold;
  const signOk =
    rule.expectation === 'decoupled' ||
    (rule.expectation === 'positive' && Math.sign(dependentMove) === Math.sign(referenceMove)) ||
    (rule.expectation === 'negative' && Math.sign(dependentMove) !== Math.sign(referenceMove));

  if (referenceJustifies && signOk) {
    return {
      ruleId: rule.id,
      dependentCoverage: rule.dependentCoverage,
      referenceCoverages: rule.referenceCoverages,
      verdict: 'coherent',
      severity: rule.severity,
      explanation: `Coherent ${rule.id}: dependent move ${dependentMove.toFixed(4)} justified by reference move ${referenceMove.toFixed(4)}.`,
      dependentMove,
      referenceMove,
    };
  }

  return {
    ruleId: rule.id,
    dependentCoverage: rule.dependentCoverage,
    referenceCoverages: rule.referenceCoverages,
    verdict: 'violation',
    severity: rule.severity,
    explanation:
      `Incoherent ${rule.id}: ${rule.dependentCoverage} moved ${dependentMove.toFixed(4)} ` +
      `but ${reference.coverage} moved ${referenceMove.toFixed(4)} ` +
      `(expected ${rule.expectation}, reference threshold ${rule.referenceThreshold}). ${rule.rationale}`,
    dependentMove,
    referenceMove,
  };
}

/**
 * Evaluate all rules for a dependent coverage against the consensus
 * observations. Returns one evaluation per applicable rule.
 */
export function evaluateConsistency(
  dependentCoverage: string,
  observations: ConsensusObservation[],
): ConsistencyEvaluation[] {
  return rulesForCoverage(dependentCoverage).map((rule) =>
    evaluateRule(rule, observations),
  );
}

/**
 * Whether any evaluation should block publication of the dependent feed.
 * Skipped rules never block.
 */
export function shouldBlockPublication(
  evaluations: ConsistencyEvaluation[],
): boolean {
  return evaluations.some(
    (evaluation) => evaluation.verdict === 'violation' && evaluation.severity === 'block',
  );
}
