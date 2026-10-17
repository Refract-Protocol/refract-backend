/**
 * Human Review Queue for High-Value and Ambiguous Oracle Decisions (Issue #282)
 *
 * Acts as a mandatory settlement gate for oracle decisions that exceed a payout
 * value threshold, carry low confidence, have immature evidence, disagree with
 * a prior decision, or originate from post-remediation re-evaluation.
 * Guarantees items are NEVER auto-approved on SLA timeout (expiry escalates).
 */

export type ReviewTriggerReason =
  | "value_above_threshold"
  | "confidence_below_floor"
  | "evidence_immaturity"
  | "disagrees_with_prior_decision"
  | "post_remediation_redecision";

export type ReviewItemStatus =
  | "pending_review"
  | "escalated"
  | "approved"
  | "rejected";

export type ReviewerRole = "viewer" | "operator" | "risk_officer" | "oracle_admin";

export interface ContributingReadingAttribution {
  sourceId: string;
  readingId: string;
  reportedValueBps: number;
  observedAtMs: number;
}

export interface ReviewDecisionInput {
  claimId: string;
  decisionId: string;
  feedId: string;
  payoutAmountStroops: bigint;
  confidenceScoreBps: number;
  isEvidenceMature: boolean;
  disagreesWithPriorDecision?: boolean;
  isPostRemediationRedecision?: boolean;
  contributingReadings: ContributingReadingAttribution[];
  anomalyFlags: string[];
  createdAtMs: number;
}

export interface ReviewQueueConfig {
  highValueThresholdStroops: bigint;
  minConfidenceFloorBps: number;
  reviewSlaWindowMs: number;
  authorizedApproverRoles: ReviewerRole[];
}

export const DEFAULT_REVIEW_QUEUE_CONFIG: ReviewQueueConfig = {
  highValueThresholdStroops: 100_000_000_000n, // 10,000 units
  minConfidenceFloorBps: 7_500, // 75% confidence floor
  reviewSlaWindowMs: 30 * 60 * 1000, // 30 minutes SLA before escalation
  authorizedApproverRoles: ["risk_officer", "oracle_admin"],
};

export interface ReviewAuditLogEntry {
  auditId: string;
  reviewItemId: string;
  action: "enqueued" | "approved" | "rejected" | "escalated" | "sla_timeout_escalated" | "evidence_invalidated";
  actorId: string;
  actorRole: ReviewerRole | "system";
  reason: string;
  timestampMs: number;
}

export interface ReviewQueueItem {
  reviewItemId: string;
  claimId: string;
  decisionId: string;
  feedId: string;
  payoutAmountStroops: bigint;
  confidenceScoreBps: number;
  triggers: ReviewTriggerReason[];
  contributingReadings: ContributingReadingAttribution[];
  anomalyFlags: string[];
  plainLanguageExplanation: string;
  status: ReviewItemStatus;
  createdAtMs: number;
  slaDeadlineMs: number;
  evidenceInvalidated: boolean;
  approvalReferenceId?: string;
  rejectionReason?: string;
}

export interface SettlementGateDecision {
  requiresHumanReview: boolean;
  canSettle: boolean;
  reviewItemId?: string;
  approvalReferenceId?: string;
  holdReason?: string;
}

export class HumanReviewQueueService {
  private readonly config: ReviewQueueConfig;
  private readonly itemsById = new Map<string, ReviewQueueItem>();
  private readonly itemIdByClaimDecision = new Map<string, string>();
  private readonly auditLog: ReviewAuditLogEntry[] = [];
  private sequence = 0;

  constructor(config: Partial<ReviewQueueConfig> = {}) {
    this.config = {
      ...DEFAULT_REVIEW_QUEUE_CONFIG,
      ...config,
    };
  }

  /**
   * Evaluates whether a decision requires human review and enqueues it idempotently if so.
   */
  evaluateAndGateSettlement(input: ReviewDecisionInput): SettlementGateDecision {
    const triggers = this.detectTriggers(input);
    if (triggers.length === 0) {
      return {
        requiresHumanReview: false,
        canSettle: true,
      };
    }

    const dedupKey = `${input.claimId}:${input.decisionId}`;
    const existingItemId = this.itemIdByClaimDecision.get(dedupKey);
    if (existingItemId) {
      const existing = this.itemsById.get(existingItemId)!;
      return this.buildGateResultFromItem(existing);
    }

    this.sequence += 1;
    const reviewItemId = `rev_${input.createdAtMs}_${this.sequence}`;
    const explanation = this.buildPlainLanguageExplanation(input, triggers);

    const item: ReviewQueueItem = {
      reviewItemId,
      claimId: input.claimId,
      decisionId: input.decisionId,
      feedId: input.feedId,
      payoutAmountStroops: input.payoutAmountStroops,
      confidenceScoreBps: input.confidenceScoreBps,
      triggers,
      contributingReadings: input.contributingReadings.map((r) => ({ ...r })),
      anomalyFlags: [...input.anomalyFlags],
      plainLanguageExplanation: explanation,
      status: "pending_review",
      createdAtMs: input.createdAtMs,
      slaDeadlineMs: input.createdAtMs + this.config.reviewSlaWindowMs,
      evidenceInvalidated: false,
    };

    this.itemsById.set(reviewItemId, item);
    this.itemIdByClaimDecision.set(dedupKey, reviewItemId);
    this.recordAudit(
      reviewItemId,
      "enqueued",
      "claimProcessor",
      "system",
      explanation,
      input.createdAtMs
    );

    return this.buildGateResultFromItem(item);
  }

  /**
   * Marks a review item's underlying evidence as invalidated so that a reviewer
   * cannot subsequently approve stale/compromised evidence.
   */
  markEvidenceInvalidated(
    reviewItemId: string,
    reason: string,
    nowMs: number
  ): ReviewQueueItem {
    const item = this.getItemOrThrow(reviewItemId);
    item.evidenceInvalidated = true;
    if (item.status === "approved") {
      item.status = "rejected";
      item.approvalReferenceId = undefined;
      item.rejectionReason = `Evidence invalidated after approval: ${reason}`;
    }
    this.recordAudit(
      reviewItemId,
      "evidence_invalidated",
      "trustEngine",
      "system",
      reason,
      nowMs
    );
    return item;
  }

  /**
   * Approves a held review item. Enforces RBAC and ensures underlying evidence
   * has not been invalidated.
   */
  approve(
    reviewItemId: string,
    actorId: string,
    actorRole: ReviewerRole,
    rationale: string,
    nowMs: number
  ): ReviewQueueItem {
    this.assertAuthorizedApprover(actorId, actorRole);
    const item = this.getItemOrThrow(reviewItemId);

    if (item.evidenceInvalidated) {
      throw new Error(
        `Cannot approve review item "${reviewItemId}": underlying consensus evidence has been invalidated`
      );
    }
    if (item.status === "rejected") {
      throw new Error(
        `Cannot approve review item "${reviewItemId}": item was already rejected`
      );
    }

    this.sequence += 1;
    item.status = "approved";
    item.approvalReferenceId = `approval_${reviewItemId}_${this.sequence}`;
    this.recordAudit(
      reviewItemId,
      "approved",
      actorId,
      actorRole,
      rationale.trim() || "Approved after human review",
      nowMs
    );
    return item;
  }

  /**
   * Rejects a held review item with a mandatory reason, returning the claim to a safe non-settling state.
   */
  reject(
    reviewItemId: string,
    actorId: string,
    actorRole: ReviewerRole,
    reason: string,
    nowMs: number
  ): ReviewQueueItem {
    this.assertAuthorizedApprover(actorId, actorRole);
    if (!reason || reason.trim() === "") {
      throw new Error("A non-empty rejection reason is required");
    }
    const item = this.getItemOrThrow(reviewItemId);
    item.status = "rejected";
    item.approvalReferenceId = undefined;
    item.rejectionReason = reason.trim();
    this.recordAudit(
      reviewItemId,
      "rejected",
      actorId,
      actorRole,
      item.rejectionReason,
      nowMs
    );
    return item;
  }

  /**
   * Manual escalation by a reviewer.
   */
  escalate(
    reviewItemId: string,
    actorId: string,
    actorRole: ReviewerRole,
    reason: string,
    nowMs: number
  ): ReviewQueueItem {
    const item = this.getItemOrThrow(reviewItemId);
    if (item.status === "approved" || item.status === "rejected") {
      throw new Error(`Cannot escalate finalized review item "${reviewItemId}"`);
    }
    item.status = "escalated";
    this.recordAudit(
      reviewItemId,
      "escalated",
      actorId,
      actorRole,
      reason.trim() || "Manual reviewer escalation",
      nowMs
    );
    return item;
  }

  /**
   * Checks SLA deadlines at `nowMs`.
   * CRITICAL (#282): Expired items are NEVER auto-approved; expiry escalates (`status = "escalated"`)
   * and keeps `canSettle = false`.
   */
  checkSlaExpirations(nowMs: number): ReviewQueueItem[] {
    const escalatedItems: ReviewQueueItem[] = [];
    for (const item of this.itemsById.values()) {
      if (item.status === "pending_review" && nowMs > item.slaDeadlineMs) {
        item.status = "escalated";
        this.recordAudit(
          item.reviewItemId,
          "sla_timeout_escalated",
          "slaWatchdog",
          "system",
          `SLA deadline (${item.slaDeadlineMs}) expired at ${nowMs}; escalated without auto-approval`,
          nowMs
        );
        escalatedItems.push(item);
      }
    }
    return escalatedItems;
  }

  /**
   * Returns current queue depth metrics for observability.
   */
  getQueueMetrics(): {
    pendingCount: number;
    escalatedCount: number;
    approvedCount: number;
    rejectedCount: number;
  } {
    let pendingCount = 0;
    let escalatedCount = 0;
    let approvedCount = 0;
    let rejectedCount = 0;
    for (const item of this.itemsById.values()) {
      if (item.status === "pending_review") pendingCount += 1;
      else if (item.status === "escalated") escalatedCount += 1;
      else if (item.status === "approved") approvedCount += 1;
      else if (item.status === "rejected") rejectedCount += 1;
    }
    return { pendingCount, escalatedCount, approvedCount, rejectedCount };
  }

  getAuditLog(): readonly ReviewAuditLogEntry[] {
    return this.auditLog;
  }

  private detectTriggers(input: ReviewDecisionInput): ReviewTriggerReason[] {
    const triggers: ReviewTriggerReason[] = [];
    if (input.payoutAmountStroops > this.config.highValueThresholdStroops) {
      triggers.push("value_above_threshold");
    }
    if (input.confidenceScoreBps < this.config.minConfidenceFloorBps) {
      triggers.push("confidence_below_floor");
    }
    if (!input.isEvidenceMature) {
      triggers.push("evidence_immaturity");
    }
    if (input.disagreesWithPriorDecision) {
      triggers.push("disagrees_with_prior_decision");
    }
    if (input.isPostRemediationRedecision) {
      triggers.push("post_remediation_redecision");
    }
    return triggers;
  }

  private buildPlainLanguageExplanation(
    input: ReviewDecisionInput,
    triggers: ReviewTriggerReason[]
  ): string {
    const sources = input.contributingReadings.map((r) => r.sourceId).join(", ") || "none";
    return (
      `Claim ${input.claimId} on feed ${input.feedId} (decision ${input.decisionId}) held for human review due to [${triggers.join(", ")}]. ` +
      `Proposed payout=${input.payoutAmountStroops.toString()} stroops, confidence=${input.confidenceScoreBps} bps, contributing sources=[${sources}].`
    );
  }

  private buildGateResultFromItem(item: ReviewQueueItem): SettlementGateDecision {
    const canSettle =
      item.status === "approved" &&
      !item.evidenceInvalidated &&
      Boolean(item.approvalReferenceId);
    return {
      requiresHumanReview: true,
      canSettle,
      reviewItemId: item.reviewItemId,
      approvalReferenceId: item.approvalReferenceId,
      holdReason: canSettle
        ? undefined
        : `Held in human review queue (status=${item.status}, triggers=${item.triggers.join(",")})`,
    };
  }

  private assertAuthorizedApprover(actorId: string, actorRole: ReviewerRole): void {
    if (!actorId || actorId.trim() === "") {
      throw new Error("actorId is required");
    }
    if (!this.config.authorizedApproverRoles.includes(actorRole)) {
      throw new Error(
        `Actor "${actorId}" with role "${actorRole}" is not authorized to approve or reject review items`
      );
    }
  }

  private getItemOrThrow(reviewItemId: string): ReviewQueueItem {
    const item = this.itemsById.get(reviewItemId);
    if (!item) {
      throw new Error(`Review queue item "${reviewItemId}" not found`);
    }
    return item;
  }

  private recordAudit(
    reviewItemId: string,
    action: ReviewAuditLogEntry["action"],
    actorId: string,
    actorRole: ReviewAuditLogEntry["actorRole"],
    reason: string,
    timestampMs: number
  ): void {
    this.sequence += 1;
    this.auditLog.push({
      auditId: `audit_${timestampMs}_${this.sequence}`,
      reviewItemId,
      action,
      actorId,
      actorRole,
      reason,
      timestampMs,
    });
  }
}
