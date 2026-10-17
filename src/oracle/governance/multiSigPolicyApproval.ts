export type PolicyProposalStatus =
  | "pending"
  | "approved_ready"
  | "executed"
  | "rejected"
  | "expired";

export interface PolicyProposalRecord {
  proposalId: string;
  coverageType: string;
  proposerId: string;
  rationale: string;
  proposedDiff: Record<string, unknown>;
  affectsPayoutTrigger: boolean;
  requiredApprovals: number;
  approvals: string[];
  rejectedBy: string | null;
  rejectionReason: string | null;
  status: PolicyProposalStatus;
  createdAtMs: number;
  effectiveAfterMs: number;
  expiresAtMs: number;
  executedAtMs: number | null;
}

export interface GovernanceAuditEvent {
  eventType:
    | "PROPOSAL_CREATED"
    | "PROPOSAL_APPROVED"
    | "PROPOSAL_REJECTED"
    | "PROPOSAL_EXECUTED"
    | "PROPOSAL_EXPIRED"
    | "EMERGENCY_PAUSE_FAST_PATH";
  proposalId: string | null;
  coverageType: string;
  actorId: string;
  timestampMs: number;
  affectsPayoutTrigger: boolean;
  details: string;
}

export class MultiSigOraclePolicyWorkflow {
  private readonly approvers: Set<string>;
  private readonly requiredApprovals: number;
  private readonly proposals = new Map<string, PolicyProposalRecord>();
  private readonly auditLog: GovernanceAuditEvent[] = [];
  private readonly applyPolicyDiff: (
    coverageType: string,
    diff: Record<string, unknown>
  ) => void;
  private nextId = 1;

  constructor(options: {
    approverAllowlist: string[];
    requiredApprovals: number;
    applyPolicyDiff: (
      coverageType: string,
      diff: Record<string, unknown>
    ) => void;
  }) {
    const cleanApprovers = new Set(
      options.approverAllowlist.map((a) => a.trim()).filter(Boolean)
    );
    // Need at least requiredApprovals + 1 distinct admins because proposer cannot self-approve
    if (
      options.requiredApprovals < 1 ||
      cleanApprovers.size < options.requiredApprovals + 1
    ) {
      throw new Error(
        "MISCONFIGURED_APPROVER_SET: Approver allowlist must contain at least (requiredApprovals + 1) distinct administrators to satisfy non-self-approval quorum"
      );
    }
    this.approvers = cleanApprovers;
    this.requiredApprovals = options.requiredApprovals;
    this.applyPolicyDiff = options.applyPolicyDiff;
  }

  public proposeChange(params: {
    proposerId: string;
    coverageType: string;
    rationale: string;
    proposedDiff: Record<string, unknown>;
    affectsPayoutTrigger: boolean;
    timelockDelayMs?: number;
    ttlMs?: number;
    nowMs?: number;
  }): PolicyProposalRecord {
    const nowMs = params.nowMs ?? Date.now();
    if (!this.approvers.has(params.proposerId)) {
      throw new Error("UNAUTHORIZED_ADMIN: Proposer is not in approver allowlist");
    }

    const proposalId = `prop-${this.nextId++}`;
    const record: PolicyProposalRecord = {
      proposalId,
      coverageType: params.coverageType,
      proposerId: params.proposerId,
      rationale: params.rationale,
      proposedDiff: { ...params.proposedDiff },
      affectsPayoutTrigger: params.affectsPayoutTrigger,
      requiredApprovals: this.requiredApprovals,
      approvals: [],
      rejectedBy: null,
      rejectionReason: null,
      status: "pending",
      createdAtMs: nowMs,
      effectiveAfterMs: nowMs + (params.timelockDelayMs ?? 0),
      expiresAtMs: nowMs + (params.ttlMs ?? 86_400_000),
      executedAtMs: null,
    };

    this.proposals.set(proposalId, record);
    this.auditLog.push({
      eventType: "PROPOSAL_CREATED",
      proposalId,
      coverageType: params.coverageType,
      actorId: params.proposerId,
      timestampMs: nowMs,
      affectsPayoutTrigger: params.affectsPayoutTrigger,
      details: params.rationale,
    });

    return record;
  }

  public approveProposal(params: {
    proposalId: string;
    approverId: string;
    nowMs?: number;
  }): PolicyProposalRecord {
    const nowMs = params.nowMs ?? Date.now();
    if (!this.approvers.has(params.approverId)) {
      throw new Error("UNAUTHORIZED_ADMIN: Approver is not in allowlist");
    }

    const prop = this.proposals.get(params.proposalId);
    if (!prop) {
      throw new Error("PROPOSAL_NOT_FOUND");
    }
    if (nowMs >= prop.expiresAtMs) {
      prop.status = "expired";
      throw new Error("PROPOSAL_EXPIRED");
    }
    if (prop.status !== "pending" && prop.status !== "approved_ready") {
      throw new Error(`INVALID_PROPOSAL_STATE: ${prop.status}`);
    }
    if (prop.proposerId === params.approverId) {
      throw new Error(
        "SELF_APPROVAL_FORBIDDEN: Proposer cannot approve their own proposal"
      );
    }
    if (prop.approvals.includes(params.approverId)) {
      throw new Error(
        "DUPLICATE_APPROVAL_FORBIDDEN: Administrator has already approved this proposal"
      );
    }

    prop.approvals.push(params.approverId);
    if (prop.approvals.length >= prop.requiredApprovals) {
      prop.status = "approved_ready";
    }

    this.auditLog.push({
      eventType: "PROPOSAL_APPROVED",
      proposalId: prop.proposalId,
      coverageType: prop.coverageType,
      actorId: params.approverId,
      timestampMs: nowMs,
      affectsPayoutTrigger: prop.affectsPayoutTrigger,
      details: `Approvals: ${prop.approvals.length}/${prop.requiredApprovals}`,
    });

    return prop;
  }

  public executeProposal(params: {
    proposalId: string;
    executorId: string;
    nowMs?: number;
  }): PolicyProposalRecord {
    const nowMs = params.nowMs ?? Date.now();
    if (!this.approvers.has(params.executorId)) {
      throw new Error("UNAUTHORIZED_ADMIN");
    }

    const prop = this.proposals.get(params.proposalId);
    if (!prop) {
      throw new Error("PROPOSAL_NOT_FOUND");
    }
    if (nowMs >= prop.expiresAtMs) {
      prop.status = "expired";
      throw new Error("PROPOSAL_EXPIRED");
    }
    if (prop.approvals.length < prop.requiredApprovals) {
      throw new Error("INSUFFICIENT_APPROVALS");
    }
    if (nowMs < prop.effectiveAfterMs) {
      throw new Error("TIMELOCK_NOT_ELAPSED");
    }
    if (prop.status === "executed") {
      throw new Error("ALREADY_EXECUTED");
    }

    this.applyPolicyDiff(prop.coverageType, prop.proposedDiff);
    prop.status = "executed";
    prop.executedAtMs = nowMs;

    this.auditLog.push({
      eventType: "PROPOSAL_EXECUTED",
      proposalId: prop.proposalId,
      coverageType: prop.coverageType,
      actorId: params.executorId,
      timestampMs: nowMs,
      affectsPayoutTrigger: prop.affectsPayoutTrigger,
      details: "Multi-sig quorum verified and policy diff applied",
    });

    return prop;
  }

  /**
   * Explicit emergency fast-path carve-out: allows an authorized administrator
   * to immediately pause a coverage feed during an active incident without waiting
   * for multi-sig quorum, while recording a high-visibility audit event.
   */
  public executeEmergencyPauseFastPath(params: {
    actorId: string;
    coverageType: string;
    incidentReason: string;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    if (!this.approvers.has(params.actorId)) {
      throw new Error("UNAUTHORIZED_ADMIN");
    }

    this.applyPolicyDiff(params.coverageType, {
      enabled: false,
      emergencyPaused: true,
    });
    this.auditLog.push({
      eventType: "EMERGENCY_PAUSE_FAST_PATH",
      proposalId: null,
      coverageType: params.coverageType,
      actorId: params.actorId,
      timestampMs: nowMs,
      affectsPayoutTrigger: true,
      details: params.incidentReason,
    });
  }

  public sweepExpiredProposals(nowMs: number = Date.now()): string[] {
    const expiredIds: string[] = [];
    for (const prop of this.proposals.values()) {
      if (
        (prop.status === "pending" || prop.status === "approved_ready") &&
        nowMs >= prop.expiresAtMs
      ) {
        prop.status = "expired";
        expiredIds.push(prop.proposalId);
        this.auditLog.push({
          eventType: "PROPOSAL_EXPIRED",
          proposalId: prop.proposalId,
          coverageType: prop.coverageType,
          actorId: "system_sweeper",
          timestampMs: nowMs,
          affectsPayoutTrigger: prop.affectsPayoutTrigger,
          details: "Proposal expired before execution",
        });
      }
    }
    return expiredIds;
  }

  public getAuditLog(): GovernanceAuditEvent[] {
    return [...this.auditLog];
  }
}
