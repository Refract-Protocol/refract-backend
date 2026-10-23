import { randomUUID } from 'crypto';
import { db } from '../db/client';
import { logger } from '../utils/logger';

export type ReviewTrigger =
  | 'value_above_threshold'
  | 'confidence_below_floor'
  | 'evidence_immaturity'
  | 'post_remediation';

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'escalated';

export type ReviewerAction = 'approve' | 'reject' | 'escalate';

export interface ReviewEvidencePacket {
  decision: unknown;
  readings: unknown[];
  sourceAttributions: unknown[];
  anomalyFlags: string[];
  explanation: string;
}

export interface ReviewQueueConfig {
  valueThreshold: number;
  confidenceFloor: number;
  slaSeconds: number;
}

export interface ReviewQueueEntry {
  id: string;
  claimId: string;
  decisionId: string;
  trigger: ReviewTrigger;
  status: ReviewStatus;
  evidence: ReviewEvidencePacket;
  createdAt: string;
  deadlineAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  rejectionReason: string | null;
}

export interface ReviewerContext {
  actor: string;
  authorized: boolean;
}

const DEFAULT_CONFIG: ReviewQueueConfig = {
  valueThreshold: 10000,
  confidenceFloor: 0.6,
  slaSeconds: 24 * 60 * 60,
};

let config: ReviewQueueConfig = { ...DEFAULT_CONFIG };

export function configureReviewQueue(overrides: Partial<ReviewQueueConfig>): void {
  config = { ...config, ...overrides };
}

export function getReviewQueueConfig(): ReviewQueueConfig {
  return { ...config };
}

export interface DecisionEvaluation {
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

export function determineTriggers(evaluation: DecisionEvaluation): ReviewTrigger[] {
  const triggers: ReviewTrigger[] = [];
  if (evaluation.value > config.valueThreshold) triggers.push('value_above_threshold');
  if (evaluation.confidence < config.confidenceFloor) triggers.push('confidence_below_floor');
  if (!evaluation.evidenceMature) triggers.push('evidence_immaturity');
  if (evaluation.postRemediation) triggers.push('post_remediation');
  return triggers;
}

export async function enqueueForReview(
  evaluation: DecisionEvaluation,
  triggers: ReviewTrigger[],
): Promise<ReviewQueueEntry> {
  const now = new Date();
  const deadline = new Date(now.getTime() + config.slaSeconds * 1000);
  const entry: ReviewQueueEntry = {
    id: randomUUID(),
    claimId: evaluation.claimId,
    decisionId: evaluation.decisionId,
    trigger: triggers[0],
    status: 'pending',
    evidence: {
      decision: evaluation.decision,
      readings: evaluation.readings,
      sourceAttributions: evaluation.sourceAttributions,
      anomalyFlags: evaluation.anomalyFlags,
      explanation: evaluation.explanation,
    },
    createdAt: now.toISOString(),
    deadlineAt: deadline.toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    rejectionReason: null,
  };

  await db.query(
    `INSERT INTO review_queue
       (id, claim_id, decision_id, trigger, status, evidence, created_at, deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.id,
      entry.claimId,
      entry.decisionId,
      entry.trigger,
      entry.status,
      JSON.stringify(entry.evidence),
      entry.createdAt,
      entry.deadlineAt,
    ],
  );

  await recordAudit(entry.id, 'enqueue', 'system', { triggers });
  logger.info({ entryId: entry.id, claimId: entry.claimId, triggers }, 'review queue entry created');
  return entry;
}

export async function getEntry(id: string): Promise<ReviewQueueEntry | null> {
  const result = await db.query('SELECT * FROM review_queue WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) return null;
  return mapRow(row);
}

export async function listPending(): Promise<ReviewQueueEntry[]> {
  const result = await db.query(
    "SELECT * FROM review_queue WHERE status IN ('pending', 'escalated') ORDER BY deadline_at ASC",
  );
  return result.rows.map(mapRow);
}

export async function queueDepth(): Promise<number> {
  const result = await db.query(
    "SELECT COUNT(*)::int AS depth FROM review_queue WHERE status IN ('pending', 'escalated')",
  );
  return result.rows[0]?.depth ?? 0;
}

export async function approve(id: string, ctx: ReviewerContext): Promise<ReviewQueueEntry> {
  assertAuthorized(ctx);
  return resolve(id, 'approved', ctx.actor, null);
}

export async function reject(
  id: string,
  ctx: ReviewerContext,
  reason: string,
): Promise<ReviewQueueEntry> {
  assertAuthorized(ctx);
  if (!reason || !reason.trim()) {
    throw new Error('rejection reason is required');
  }
  return resolve(id, 'rejected', ctx.actor, reason.trim());
}

export async function escalate(id: string, ctx: ReviewerContext): Promise<ReviewQueueEntry> {
  assertAuthorized(ctx);
  return resolve(id, 'escalated', ctx.actor, null);
}

async function resolve(
  id: string,
  status: ReviewStatus,
  actor: string,
  reason: string | null,
): Promise<ReviewQueueEntry> {
  const entry = await getEntry(id);
  if (!entry) throw new Error(`review queue entry ${id} not found`);
  if (entry.status === 'approved' || entry.status === 'rejected') {
    throw new Error(`review queue entry ${id} already resolved as ${entry.status}`);
  }

  const resolvedAt = new Date().toISOString();
  await db.query(
    `UPDATE review_queue
        SET status = $1, resolved_at = $2, resolved_by = $3, rejection_reason = $4
      WHERE id = $5`,
    [status, resolvedAt, actor, reason, id],
  );

  await recordAudit(id, status, actor, { reason });
  logger.info({ entryId: id, status, actor }, 'review queue entry resolved');

  return { ...entry, status, resolvedAt, resolvedBy: actor, rejectionReason: reason };
}

/**
 * Escalate any pending items whose deadline has passed. Items are never
 * auto-approved by timeout — expiry only escalates.
 */
export async function sweepExpired(now: Date = new Date()): Promise<number> {
  const result = await db.query(
    "SELECT id FROM review_queue WHERE status = 'pending' AND deadline_at <= $1",
    [now.toISOString()],
  );
  for (const row of result.rows) {
    await escalate(row.id, { actor: 'system:sla', authorized: true });
  }
  return result.rows.length;
}

/**
 * Settlement gate: a decision may only settle when it has an approved queue
 * entry, or when it was never queued at all.
 */
export async function assertSettlementAllowed(decisionId: string): Promise<void> {
  const result = await db.query(
    'SELECT status FROM review_queue WHERE decision_id = $1 ORDER BY created_at DESC LIMIT 1',
    [decisionId],
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.status !== 'approved') {
    throw new Error(
      `decision ${decisionId} cannot settle: review queue status is ${row.status}`,
    );
  }
}

async function recordAudit(
  entryId: string,
  action: string,
  actor: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO review_audit (id, entry_id, action, actor, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), entryId, action, actor, JSON.stringify(detail), new Date().toISOString()],
  );
}

function assertAuthorized(ctx: ReviewerContext): void {
  if (!ctx.authorized) {
    throw new Error(`actor ${ctx.actor} is not authorized to act on review queue items`);
  }
}

function mapRow(row: Record<string, unknown>): ReviewQueueEntry {
  const evidence =
    typeof row.evidence === 'string' ? JSON.parse(row.evidence) : (row.evidence as ReviewEvidencePacket);
  return {
    id: row.id as string,
    claimId: row.claim_id as string,
    decisionId: row.decision_id as string,
    trigger: row.trigger as ReviewTrigger,
    status: row.status as ReviewStatus,
    evidence,
    createdAt: row.created_at as string,
    deadlineAt: row.deadline_at as string,
    resolvedAt: (row.resolved_at as string) ?? null,
    resolvedBy: (row.resolved_by as string) ?? null,
    rejectionReason: (row.rejection_reason as string) ?? null,
  };
}
