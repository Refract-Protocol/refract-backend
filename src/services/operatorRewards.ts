/**
 * Operator Reward Accrual and Distribution for Honest Oracle Participation (Issue #281)
 *
 * Derives per-round operator rewards deterministically from committed consensus decisions,
 * weights shares by stake and reputation with a per-operator dominance cap, enforces
 * idempotency across retries/re-orgs, supports post-remediation clawbacks, and gates
 * scheduled distributions behind a dispute window and minimum payout threshold.
 */

export const BPS_DENOMINATOR = 10_000n;

export type SubmissionEligibilityStatus =
  | "included_in_consensus"
  | "late_after_watermark"
  | "quarantined"
  | "duplicate";

export interface OperatorSubmissionRecord {
  operatorId: string;
  readingId: string;
  status: SubmissionEligibilityStatus;
  /** Operator stake in stroops (may be 0n if unbonded/minimum tier) */
  stakeStroops: bigint;
  /** Operator reputation score in basis points (0..10000) */
  reputationScoreBps: number;
}

export interface CommittedConsensusRoundInput {
  /** Unique committed consensus decision ID (used for idempotency) */
  decisionId: string;
  feedId: string;
  roundNumber: number;
  committedAtMs: number;
  /** Total reward pool allocated to this consensus round in stroops */
  roundRewardPoolStroops: bigint;
  submissions: OperatorSubmissionRecord[];
}

export interface RewardEngineConfig {
  /** Base weight in stroops-equivalent granted to every honest included reading so zero-stake operators still earn a base share */
  baseParticipationFloorStroops: bigint;
  /** Maximum share of a single round's reward pool any single operator can earn in basis points (e.g. 4000 = 40%) */
  maxSingleOperatorShareBps: number;
  /** Dispute window duration in milliseconds before accrued rewards become eligible for payout */
  disputeWindowMs: number;
  /** Minimum matured balance in stroops required to trigger a payout transfer */
  minPayoutThresholdStroops: bigint;
}

export const DEFAULT_REWARD_ENGINE_CONFIG: RewardEngineConfig = {
  baseParticipationFloorStroops: 100_000_000n, // 10 units base floor
  maxSingleOperatorShareBps: 4_000, // 40% cap per operator per round
  disputeWindowMs: 24 * 60 * 60 * 1000, // 24h dispute window
  minPayoutThresholdStroops: 50_000_000n, // 5 units minimum payout
};

export interface AccrualLedgerEntry {
  idempotencyKey: string;
  decisionId: string;
  feedId: string;
  roundNumber: number;
  operatorId: string;
  readingId: string;
  amountStroops: bigint;
  accruedAtMs: number;
  maturesAtMs: number;
  status: "pending_dispute_window" | "invalidated_by_remediation" | "paid";
  invalidationReason?: string;
  payoutId?: string;
}

export interface PayoutBatchRecord {
  payoutId: string;
  operatorId: string;
  amountStroops: bigint;
  distributedAtMs: number;
  includedAccrualKeys: string[];
}

export interface OperatorRewardSummary {
  operatorId: string;
  /** Total rewards accrued across all non-invalidated rounds */
  totalValidAccruedStroops: bigint;
  /** Rewards still inside the dispute window */
  pendingDisputeWindowStroops: bigint;
  /** Rewards past the dispute window and not yet paid */
  maturedUnpaidStroops: bigint;
  /** Rewards revoked due to post-consensus decision invalidation / remediation */
  invalidatedStroops: bigint;
  /** Total rewards already paid out */
  paidStroops: bigint;
  accruals: AccrualLedgerEntry[];
  payouts: PayoutBatchRecord[];
}

export class OperatorRewardEngine {
  private readonly config: RewardEngineConfig;
  private readonly accrualsByKey = new Map<string, AccrualLedgerEntry>();
  private readonly processedDecisionIds = new Set<string>();
  private readonly payouts: PayoutBatchRecord[] = [];
  private payoutSequence = 0;

  constructor(config: Partial<RewardEngineConfig> = {}) {
    this.config = {
      ...DEFAULT_REWARD_ENGINE_CONFIG,
      ...config,
    };
    if (
      this.config.maxSingleOperatorShareBps <= 0 ||
      this.config.maxSingleOperatorShareBps > 10_000
    ) {
      throw new Error("maxSingleOperatorShareBps must be within 1..10000");
    }
  }

  /**
   * Processes a committed consensus round and accrues rewards exclusively to
   * unique operators whose submission has status === "included_in_consensus".
   *
   * Idempotent: re-delivering the same `decisionId` returns the existing entries
   * without double-crediting.
   */
  accrueRoundRewards(round: CommittedConsensusRoundInput): AccrualLedgerEntry[] {
    if (this.processedDecisionIds.has(round.decisionId)) {
      return Array.from(this.accrualsByKey.values()).filter(
        (e) => e.decisionId === round.decisionId
      );
    }

    if (round.roundRewardPoolStroops <= 0n) {
      this.processedDecisionIds.add(round.decisionId);
      return [];
    }

    // Filter eligible submissions: only "included_in_consensus" and deduplicated per operatorId
    const seenOperators = new Set<string>();
    const eligible: OperatorSubmissionRecord[] = [];
    for (const sub of round.submissions) {
      if (sub.status !== "included_in_consensus") {
        continue;
      }
      if (seenOperators.has(sub.operatorId)) {
        continue;
      }
      if (sub.reputationScoreBps <= 0) {
        continue;
      }
      seenOperators.add(sub.operatorId);
      eligible.push(sub);
    }

    if (eligible.length === 0) {
      this.processedDecisionIds.add(round.decisionId);
      return [];
    }

    // Weight formula:
    // effectiveStake = max(0n, stakeStroops) + baseParticipationFloorStroops
    // rawWeight = (effectiveStake * BigInt(clampedReputationBps)) / 10_000n
    const weights = eligible.map((sub) => {
      const clampedRep = BigInt(
        Math.max(0, Math.min(10_000, Math.trunc(sub.reputationScoreBps)))
      );
      const effectiveStake =
        (sub.stakeStroops > 0n ? sub.stakeStroops : 0n) +
        this.config.baseParticipationFloorStroops;
      const rawWeight = (effectiveStake * clampedRep) / BPS_DENOMINATOR;
      return rawWeight > 0n ? rawWeight : 1n;
    });

    const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
    const maxCapStroops =
      (round.roundRewardPoolStroops *
        BigInt(this.config.maxSingleOperatorShareBps)) /
      BPS_DENOMINATOR;

    const created: AccrualLedgerEntry[] = [];
    for (let i = 0; i < eligible.length; i++) {
      const sub = eligible[i];
      const weight = weights[i];
      // Proportional share rounded down (dust remains in treasury / unallocated pool, never over-minted)
      const uncappedShare =
        (round.roundRewardPoolStroops * weight) / totalWeight;
      const finalAmount =
        uncappedShare > maxCapStroops ? maxCapStroops : uncappedShare;

      if (finalAmount <= 0n) {
        continue;
      }

      const idempotencyKey = `${round.decisionId}:${sub.operatorId}`;
      const entry: AccrualLedgerEntry = {
        idempotencyKey,
        decisionId: round.decisionId,
        feedId: round.feedId,
        roundNumber: round.roundNumber,
        operatorId: sub.operatorId,
        readingId: sub.readingId,
        amountStroops: finalAmount,
        accruedAtMs: round.committedAtMs,
        maturesAtMs: round.committedAtMs + this.config.disputeWindowMs,
        status: "pending_dispute_window",
      };
      this.accrualsByKey.set(idempotencyKey, entry);
      created.push(entry);
    }

    this.processedDecisionIds.add(round.decisionId);
    return created;
  }

  /**
   * Invalidates accruals tied to a consensus decision that was later overturned
   * by claim remediation (only unpaid accruals can be invalidated in-place).
   */
  invalidateDecisionRewards(
    decisionId: string,
    reason: string
  ): AccrualLedgerEntry[] {
    const invalidated: AccrualLedgerEntry[] = [];
    for (const entry of this.accrualsByKey.values()) {
      if (
        entry.decisionId === decisionId &&
        entry.status === "pending_dispute_window"
      ) {
        entry.status = "invalidated_by_remediation";
        entry.invalidationReason = reason;
        invalidated.push(entry);
      }
    }
    return invalidated;
  }

  /**
   * Executes scheduled reward distribution at `nowMs`.
   * Only accruals whose dispute window has elapsed (`maturesAtMs <= nowMs`) and
   * that have not been invalidated or paid are eligible.
   * An operator is paid only when their total matured unpaid balance >= `minPayoutThresholdStroops`.
   */
  runScheduledDistribution(nowMs: number): PayoutBatchRecord[] {
    const maturedByOperator = new Map<string, AccrualLedgerEntry[]>();

    for (const entry of this.accrualsByKey.values()) {
      if (
        entry.status === "pending_dispute_window" &&
        entry.maturesAtMs <= nowMs
      ) {
        const list = maturedByOperator.get(entry.operatorId) ?? [];
        list.push(entry);
        maturedByOperator.set(entry.operatorId, list);
      }
    }

    const batches: PayoutBatchRecord[] = [];
    for (const [operatorId, entries] of maturedByOperator.entries()) {
      const totalMatured = entries.reduce((sum, e) => sum + e.amountStroops, 0n);
      if (totalMatured < this.config.minPayoutThresholdStroops) {
        continue;
      }

      this.payoutSequence += 1;
      const payoutId = `payout_${nowMs}_${this.payoutSequence}_${operatorId}`;
      const includedAccrualKeys = entries.map((e) => e.idempotencyKey);

      for (const entry of entries) {
        entry.status = "paid";
        entry.payoutId = payoutId;
      }

      const batch: PayoutBatchRecord = {
        payoutId,
        operatorId,
        amountStroops: totalMatured,
        distributedAtMs: nowMs,
        includedAccrualKeys,
      };
      this.payouts.push(batch);
      batches.push(batch);
    }

    return batches;
  }

  /**
   * Returns an operator-facing accounting view of accrued, pending, matured,
   * invalidated, and paid rewards as of `nowMs`.
   */
  getOperatorRewardSummary(
    operatorId: string,
    nowMs: number
  ): OperatorRewardSummary {
    const accruals = Array.from(this.accrualsByKey.values()).filter(
      (e) => e.operatorId === operatorId
    );
    const payouts = this.payouts.filter((p) => p.operatorId === operatorId);

    let totalValidAccruedStroops = 0n;
    let pendingDisputeWindowStroops = 0n;
    let maturedUnpaidStroops = 0n;
    let invalidatedStroops = 0n;
    let paidStroops = 0n;

    for (const entry of accruals) {
      if (entry.status === "invalidated_by_remediation") {
        invalidatedStroops += entry.amountStroops;
        continue;
      }
      totalValidAccruedStroops += entry.amountStroops;
      if (entry.status === "paid") {
        paidStroops += entry.amountStroops;
      } else if (entry.maturesAtMs > nowMs) {
        pendingDisputeWindowStroops += entry.amountStroops;
      } else {
        maturedUnpaidStroops += entry.amountStroops;
      }
    }

    return {
      operatorId,
      totalValidAccruedStroops,
      pendingDisputeWindowStroops,
      maturedUnpaidStroops,
      invalidatedStroops,
      paidStroops,
      accruals,
      payouts,
    };
  }
}
