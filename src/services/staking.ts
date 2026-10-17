export type FeedBondTier = "tier_standard" | "tier_high_value" | "tier_critical";

export type SlashReason =
  | "out_of_tolerance_submission"
  | "post_quarantine_submission"
  | "equivocation_double_submission";

export type SlashingProposalStatus = "pending" | "executed" | "rejected";

export interface SlashingProposal {
  proposalId: string;
  operatorId: string;
  evidenceId: string;
  reason: SlashReason;
  slashBasisPoints: number;
  proposedSlashAmount: bigint;
  executedSlashAmount?: bigint;
  status: SlashingProposalStatus;
  approvals: string[];
  createdAtMs: number;
  executedAtMs?: number;
}

export interface UnbondRequest {
  requestId: string;
  operatorId: string;
  amount: bigint;
  requestedAtMs: number;
  unlockAtMs: number;
  withdrawn: boolean;
}

export interface OperatorStakeAccount {
  operatorId: string;
  activeBondedAmount: bigint;
  firstBondedAtMs: number;
  lastBondedAtMs: number;
  totalSlashedAmount: bigint;
}

export interface StakingPolicyConfig {
  minBondByTier: Record<FeedBondTier, bigint>;
  minBondAgeMs: number;
  unbondingPeriodMs: number;
  requiredSlashApprovals: number;
  authorizedApprovers: string[];
  slashBpsByReason?: Record<SlashReason, number>;
}

export interface OperatorStakeStatusView {
  operatorId: string;
  activeBondedAmount: bigint;
  totalSlashedAmount: bigint;
  bondAgeMs: number;
  unbondRequests: Array<{
    requestId: string;
    amount: bigint;
    unlockAtMs: number;
    remainingMs: number;
    withdrawn: boolean;
  }>;
  pendingSlashingProposals: SlashingProposal[];
}

export class OperatorStakingService {
  private readonly accounts = new Map<string, OperatorStakeAccount>();
  private readonly unbondRequests = new Map<string, UnbondRequest[]>();
  private readonly proposalsById = new Map<string, SlashingProposal>();
  private readonly proposalByEvidenceKey = new Map<string, string>();
  private readonly config: StakingPolicyConfig;
  private readonly slashBpsByReason: Record<SlashReason, number>;
  private seq = 0;

  constructor(config: StakingPolicyConfig) {
    if (config.requiredSlashApprovals < 1) {
      throw new Error("requiredSlashApprovals must be >= 1");
    }
    this.config = config;
    this.slashBpsByReason = config.slashBpsByReason ?? {
      out_of_tolerance_submission: 1_000, // 10%
      post_quarantine_submission: 2_000, // 20%
      equivocation_double_submission: 5_000, // 50%
    };
  }

  public bond(
    operatorId: string,
    amount: bigint,
    nowMs: number = Date.now()
  ): OperatorStakeAccount {
    if (amount <= 0n) {
      throw new Error("Bond amount must be positive");
    }
    const existing = this.accounts.get(operatorId);
    if (!existing) {
      const created: OperatorStakeAccount = {
        operatorId,
        activeBondedAmount: amount,
        firstBondedAtMs: nowMs,
        lastBondedAtMs: nowMs,
        totalSlashedAmount: 0n,
      };
      this.accounts.set(operatorId, created);
      return { ...created };
    }

    existing.activeBondedAmount += amount;
    existing.lastBondedAtMs = nowMs;
    return { ...existing };
  }

  public isEligibleForFeedQuorum(
    operatorId: string,
    tier: FeedBondTier,
    nowMs: number = Date.now()
  ): { eligible: boolean; reason?: string } {
    const account = this.accounts.get(operatorId);
    if (!account) {
      return { eligible: false, reason: "NO_BOND_ACCOUNT" };
    }

    const bondAgeMs = nowMs - account.firstBondedAtMs;
    if (bondAgeMs < this.config.minBondAgeMs) {
      return { eligible: false, reason: "BOND_AGE_TOO_YOUNG" };
    }

    const minRequired = this.config.minBondByTier[tier];
    if (account.activeBondedAmount < minRequired) {
      return { eligible: false, reason: "INSUFFICIENT_BOND_FOR_TIER" };
    }

    return { eligible: true };
  }

  public requestUnbond(
    operatorId: string,
    amount: bigint,
    nowMs: number = Date.now()
  ): UnbondRequest {
    if (amount <= 0n) {
      throw new Error("Unbond amount must be positive");
    }
    const account = this.accounts.get(operatorId);
    if (!account || account.activeBondedAmount < amount) {
      throw new Error("Insufficient active bonded balance for unbond request");
    }

    account.activeBondedAmount -= amount;
    this.seq += 1;
    const req: UnbondRequest = {
      requestId: `unbond-${this.seq}`,
      operatorId,
      amount,
      requestedAtMs: nowMs,
      unlockAtMs: nowMs + this.config.unbondingPeriodMs,
      withdrawn: false,
    };

    const list = this.unbondRequests.get(operatorId) ?? [];
    list.push(req);
    this.unbondRequests.set(operatorId, list);
    return { ...req };
  }

  public withdrawUnbonded(
    operatorId: string,
    requestId: string,
    nowMs: number = Date.now()
  ): { withdrawnAmount: bigint } {
    const pendingProposals = this.getPendingProposalsForOperator(operatorId);
    if (pendingProposals.length > 0) {
      throw new Error(
        `Cannot withdraw unbonded stake while ${pendingProposals.length} slashing proposal(s) are pending`
      );
    }

    const list = this.unbondRequests.get(operatorId) ?? [];
    const req = list.find((r) => r.requestId === requestId);
    if (!req) {
      throw new Error(`Unbond request ${requestId} not found`);
    }
    if (req.withdrawn) {
      throw new Error(`Unbond request ${requestId} already withdrawn`);
    }
    if (nowMs < req.unlockAtMs) {
      throw new Error(
        `Unbonding period not elapsed (unlocks at ${req.unlockAtMs}, now ${nowMs})`
      );
    }

    req.withdrawn = true;
    return { withdrawnAmount: req.amount };
  }

  public proposeSlash(params: {
    operatorId: string;
    evidenceId: string;
    reason: SlashReason;
    nowMs?: number;
  }): SlashingProposal {
    const nowMs = params.nowMs ?? Date.now();
    const dedupKey = `${params.operatorId}:${params.evidenceId}`;
    const existingId = this.proposalByEvidenceKey.get(dedupKey);
    if (existingId) {
      return { ...this.proposalsById.get(existingId)! };
    }

    const account = this.accounts.get(params.operatorId);
    if (!account) {
      throw new Error(`Unknown operator ${params.operatorId}`);
    }

    const totalSlashablePool =
      account.activeBondedAmount + this.getLockedUnbondingAmount(params.operatorId);
    const bps = this.slashBpsByReason[params.reason];
    const rawSlash = (totalSlashablePool * BigInt(bps)) / 10_000n;
    const proposedSlashAmount =
      rawSlash > totalSlashablePool ? totalSlashablePool : rawSlash;

    this.seq += 1;
    const proposal: SlashingProposal = {
      proposalId: `slash-${this.seq}`,
      operatorId: params.operatorId,
      evidenceId: params.evidenceId,
      reason: params.reason,
      slashBasisPoints: bps,
      proposedSlashAmount,
      status: "pending",
      approvals: [],
      createdAtMs: nowMs,
    };

    this.proposalsById.set(proposal.proposalId, proposal);
    this.proposalByEvidenceKey.set(dedupKey, proposal.proposalId);
    return { ...proposal };
  }

  public approveAndExecuteSlash(
    proposalId: string,
    approverId: string,
    nowMs: number = Date.now()
  ): SlashingProposal {
    if (!this.config.authorizedApprovers.includes(approverId)) {
      throw new Error(`Unauthorized slash approver: ${approverId}`);
    }

    const proposal = this.proposalsById.get(proposalId);
    if (!proposal) {
      throw new Error(`Slashing proposal ${proposalId} not found`);
    }

    if (proposal.status === "executed") {
      return { ...proposal };
    }

    if (!proposal.approvals.includes(approverId)) {
      proposal.approvals.push(approverId);
    }

    if (proposal.approvals.length < this.config.requiredSlashApprovals) {
      return { ...proposal };
    }

    const account = this.accounts.get(proposal.operatorId)!;
    let remainingToSlash = proposal.proposedSlashAmount;

    // Deduct from active bonded balance first, then locked unbonding requests
    const fromActive =
      account.activeBondedAmount >= remainingToSlash
        ? remainingToSlash
        : account.activeBondedAmount;
    account.activeBondedAmount -= fromActive;
    remainingToSlash -= fromActive;

    if (remainingToSlash > 0n) {
      const list = this.unbondRequests.get(proposal.operatorId) ?? [];
      for (const req of list) {
        if (!req.withdrawn && remainingToSlash > 0n) {
          const cut =
            req.amount >= remainingToSlash ? remainingToSlash : req.amount;
          req.amount -= cut;
          remainingToSlash -= cut;
        }
      }
    }

    const executedSlashAmount = proposal.proposedSlashAmount - remainingToSlash;
    account.totalSlashedAmount += executedSlashAmount;
    proposal.executedSlashAmount = executedSlashAmount;
    proposal.status = "executed";
    proposal.executedAtMs = nowMs;

    return { ...proposal };
  }

  public getOperatorStakeStatus(
    operatorId: string,
    nowMs: number = Date.now()
  ): OperatorStakeStatusView {
    const account = this.accounts.get(operatorId);
    if (!account) {
      throw new Error(`Operator ${operatorId} has no stake account`);
    }
    const requests = this.unbondRequests.get(operatorId) ?? [];
    return {
      operatorId,
      activeBondedAmount: account.activeBondedAmount,
      totalSlashedAmount: account.totalSlashedAmount,
      bondAgeMs: Math.max(0, nowMs - account.firstBondedAtMs),
      unbondRequests: requests.map((r) => ({
        requestId: r.requestId,
        amount: r.amount,
        unlockAtMs: r.unlockAtMs,
        remainingMs: r.withdrawn ? 0 : Math.max(0, r.unlockAtMs - nowMs),
        withdrawn: r.withdrawn,
      })),
      pendingSlashingProposals: this.getPendingProposalsForOperator(operatorId),
    };
  }

  private getLockedUnbondingAmount(operatorId: string): bigint {
    const list = this.unbondRequests.get(operatorId) ?? [];
    return list
      .filter((r) => !r.withdrawn)
      .reduce((acc, r) => acc + r.amount, 0n);
  }

  private getPendingProposalsForOperator(
    operatorId: string
  ): SlashingProposal[] {
    const results: SlashingProposal[] = [];
    for (const p of this.proposalsById.values()) {
      if (p.operatorId === operatorId && p.status === "pending") {
        results.push({ ...p });
      }
    }
    return results;
  }
}
