import { logger } from '../utils/logger';
import {
  DecisionEvaluation,
  assertSettlementAllowed,
  determineTriggers,
  enqueueForReview,
} from './reviewQueue';

export interface ClaimDecision {
  claimId: string;
  decisionId: string;
  value: number;
  confidence: number;
  evidenceMature: boolean;
  postRemediation: boolean;
  decision: unknown;
  readings: unknown[];
  sourceAttributions: unknown[];
  anomalyFlags: string[];
  explanation: string;
}

export type ProcessOutcome =
  | { status: 'settled'; decisionId: string }
  | { status: 'held_for_review'; decisionId: string; reviewEntryId: string };

export async function processClaim(claim: ClaimDecision): Promise<ProcessOutcome> {
  const evaluation: DecisionEvaluation = {
    claimId: claim.claimId,
    decisionId: claim.decisionId,
    value: claim.value,
    confidence: claim.confidence,
    evidenceMature: claim.evidenceMature,
    postRemediation: claim.postRemediation,
    decision: claim.decision,
    readings: claim.readings,
    sourceAttributions: claim.sourceAttributions,
    anomalyFlags: claim.anomalyFlags,
    explanation: claim.explanation,
  };

  const triggers = determineTriggers(evaluation);
  if (triggers.length > 0) {
    const entry = await enqueueForReview(evaluation, triggers);
    logger.info(
      { claimId: claim.claimId, decisionId: claim.decisionId, triggers },
      'claim decision held for human review',
    );
    return { status: 'held_for_review', decisionId: claim.decisionId, reviewEntryId: entry.id };
  }

  await assertSettlementAllowed(claim.decisionId);
  logger.info({ claimId: claim.claimId, decisionId: claim.decisionId }, 'claim decision settled');
  return { status: 'settled', decisionId: claim.decisionId };
}
